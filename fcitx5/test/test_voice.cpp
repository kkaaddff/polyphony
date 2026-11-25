// 集成测试:起一个真实的 Fcitx5 Instance(只加载本模块),测试进程扮演 Polyphony 桌面壳
// (Unix Socket 服务端)和应用(自定义 InputContext),逐条验证 docs/voice-input.md §5 的行为。
// 覆盖不到的只有「真实应用如何渲染 Preedit」—— 那必须在真机桌面上测。
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcitx-utils/capabilityflags.h>
#include <fcitx-utils/eventdispatcher.h>
#include <fcitx-utils/key.h>
#include <fcitx-utils/testing.h>
#include <fcitx/addonmanager.h>
#include <fcitx/event.h>
#include <fcitx/inputcontext.h>
#include <fcitx/inputcontextmanager.h>
#include <fcitx/inputpanel.h>
#include <fcitx/instance.h>
#include <functional>
#include <future>
#include <memory>
#include <nlohmann/json.hpp>
#include <poll.h>
#include <string>
#include <sys/socket.h>
#include <sys/un.h>
#include <thread>
#include <unistd.h>
#include <vector>

using json = nlohmann::json;

#define CHECK(cond)                                                                                \
    do {                                                                                           \
        if (!(cond)) {                                                                             \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                   \
            std::fflush(stderr);                                                                   \
            std::_Exit(1);                                                                         \
        }                                                                                          \
    } while (0)

/// 扮演「应用里的一个输入框」:记录收到的 Preedit 与提交。
class TestIC : public fcitx::InputContext {
public:
    TestIC(fcitx::InputContextManager &manager, fcitx::CapabilityFlags flags)
        : fcitx::InputContext(manager, "test-app") {
        setCapabilityFlags(flags);
        created();
    }
    ~TestIC() override { destroy(); }

    const char *frontend() const override { return "test"; }
    void commitStringImpl(const std::string &text) override { commits.push_back(text); }
    void deleteSurroundingTextImpl(int, unsigned int) override {}
    void forwardKeyImpl(const fcitx::ForwardKeyEvent &) override {}
    void updatePreeditImpl() override { preedit = inputPanel().clientPreedit().toString(); }

    std::string preedit;
    std::vector<std::string> commits;
};

namespace {

fcitx::EventDispatcher dispatcher;

/// 在 Fcitx 主线程上执行并等结果(所有 InputContext 操作都必须在主线程)。
template <typename F>
auto onMain(F fn) -> decltype(fn()) {
    std::promise<decltype(fn())> done;
    dispatcher.schedule([&] { done.set_value(fn()); });
    return done.get_future().get();
}

bool waitFor(const std::function<bool()> &pred, int timeoutMs = 3000) {
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
        if (onMain([&] { return pred(); })) {
            return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return false;
}

/// 桌面壳一侧的连接。
struct Daemon {
    int listenFd = -1;
    int conn = -1;
    std::string buf;

    explicit Daemon(const std::string &path) {
        ::unlink(path.c_str());
        listenFd = ::socket(AF_UNIX, SOCK_STREAM, 0);
        sockaddr_un addr{};
        addr.sun_family = AF_UNIX;
        std::strncpy(addr.sun_path, path.c_str(), sizeof(addr.sun_path) - 1);
        CHECK(::bind(listenFd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) == 0);
        CHECK(::listen(listenFd, 4) == 0);
    }

    void accept(int timeoutMs) {
        pollfd p{listenFd, POLLIN, 0};
        CHECK(::poll(&p, 1, timeoutMs) == 1);
        conn = ::accept(listenFd, nullptr, nullptr);
        CHECK(conn >= 0);
        buf.clear();
        send({{"type", "hello"}, {"version", 1}});
    }

    void drop() {
        ::close(conn);
        conn = -1;
    }

    void send(const json &msg) {
        std::string line = msg.dump() + "\n";
        CHECK(::write(conn, line.data(), line.size()) == static_cast<ssize_t>(line.size()));
    }
    void start(const std::string &id) { send({{"type", "session.start"}, {"session_id", id}}); }
    void preedit(const std::string &id, int rev, const std::string &text) {
        send({{"type", "preedit.update"}, {"session_id", id}, {"revision", rev}, {"text", text}});
    }
    void commit(const std::string &id, const std::string &text) {
        send({{"type", "session.commit"}, {"session_id", id}, {"revision", 99}, {"text", text}});
    }
    void cancel(const std::string &id) { send({{"type", "session.cancel"}, {"session_id", id}}); }

    /// 读插件上行的下一行状态;超时返回 null。
    json nextStatus(int timeoutMs = 3000) {
        for (;;) {
            auto pos = buf.find('\n');
            if (pos != std::string::npos) {
                std::string line = buf.substr(0, pos);
                buf.erase(0, pos + 1);
                return json::parse(line);
            }
            pollfd p{conn, POLLIN, 0};
            if (::poll(&p, 1, timeoutMs) != 1) {
                return nullptr;
            }
            char tmp[1024];
            ssize_t n = ::read(conn, tmp, sizeof(tmp));
            if (n <= 0) {
                return nullptr;
            }
            buf.append(tmp, static_cast<size_t>(n));
        }
    }

    void expectStatus(const std::string &id, const std::string &status, const std::string &reason = "") {
        json s = nextStatus();
        if (s.is_null() || s.value("session_id", "") != id || s.value("status", "") != status ||
            s.value("reason", "") != reason) {
            std::fprintf(stderr, "FAIL expected status %s/%s for %s, got %s\n", status.c_str(),
                         reason.c_str(), id.c_str(), s.dump().c_str());
            std::_Exit(1);
        }
    }

    void expectQuiet(int ms = 200) { CHECK(nextStatus(ms).is_null()); }
};

void step(const char *name) {
    std::fprintf(stderr, "  ok  %s\n", name);
    std::fflush(stderr);
}

} // namespace

int main() {
    const std::string sock = "/tmp/polyphony-voice-test-" + std::to_string(::getpid()) + ".sock";
    ::setenv("POLYPHONY_VOICE_SOCKET", sock.c_str(), 1);
    fcitx::setupTestingEnvironment(TEST_BINARY_DIR, {"src"}, {"test"});

    Daemon daemon(sock); // 先监听:模块加载后第一次连接就能成功

    char arg0[] = "test_voice", arg1[] = "--disable=all", arg2[] = "--enable=polyphonyvoice";
    char *argv[] = {arg0, arg1, arg2};
    fcitx::Instance instance(3, argv);
    instance.addonManager().registerDefaultLoader(nullptr);
    dispatcher.attach(&instance.eventLoop());

    const fcitx::CapabilityFlags normal{fcitx::CapabilityFlag::Preedit};
    std::unique_ptr<TestIC> a, b, pw;

    std::thread script([&] {
        daemon.accept(10000);
        onMain([&] {
            auto &mgr = instance.inputContextManager();
            a = std::make_unique<TestIC>(mgr, normal);
            b = std::make_unique<TestIC>(mgr, normal);
            pw = std::make_unique<TestIC>(
                mgr, fcitx::CapabilityFlags{fcitx::CapabilityFlag::Preedit, fcitx::CapabilityFlag::Password});
            a->focusIn();
            return 0;
        });

        // 1. 实时显示 + 识别修正整体替换 + 提交终稿
        daemon.start("s1");
        daemon.preedit("s1", 1, "帮我创建一个明天下午三点开会的认物");
        CHECK(waitFor([&] { return a->preedit == "帮我创建一个明天下午三点开会的认物"; }));
        daemon.preedit("s1", 2, "帮我创建一个明天下午三点开会的任务");
        CHECK(waitFor([&] { return a->preedit == "帮我创建一个明天下午三点开会的任务"; }));
        daemon.commit("s1", "帮我创建一个明天下午三点开会的任务。");
        daemon.expectStatus("s1", "committed");
        CHECK(onMain([&] {
            return a->commits == std::vector<std::string>{"帮我创建一个明天下午三点开会的任务。"} &&
                   a->preedit.empty();
        }));
        step("live preedit, rewrite replaces, commit uses final text");

        // 2. 连续多句:不重复追加
        daemon.start("s2");
        daemon.preedit("s2", 1, "第二句");
        CHECK(waitFor([&] { return a->preedit == "第二句"; }));
        daemon.commit("s2", "第二句");
        daemon.expectStatus("s2", "committed");
        CHECK(onMain([&] { return a->commits.size() == 2 && a->commits[1] == "第二句"; }));
        step("consecutive sessions do not duplicate");

        // 3. 取消:清 Preedit,不提交
        daemon.start("s3");
        daemon.preedit("s3", 1, "不要了");
        CHECK(waitFor([&] { return a->preedit == "不要了"; }));
        daemon.cancel("s3");
        CHECK(waitFor([&] { return a->preedit.empty(); }));
        CHECK(onMain([&] { return a->commits.size() == 2; }));
        step("cancel clears preedit without committing");

        // 4. 焦点保护:切到别的输入框后不注入;提交被拒绝
        daemon.start("s4");
        daemon.preedit("s4", 1, "写给 A 的话");
        CHECK(waitFor([&] { return a->preedit == "写给 A 的话"; }));
        onMain([&] {
            a->focusOut();
            b->focusIn();
            return 0;
        });
        daemon.expectStatus("s4", "suspended", "focus_lost");
        daemon.preedit("s4", 2, "写给 A 的话还在继续");
        daemon.expectQuiet();
        CHECK(onMain([&] { return b->preedit.empty() && b->commits.empty() && a->preedit.empty(); }));
        daemon.commit("s4", "写给 A 的话还在继续");
        daemon.expectStatus("s4", "rejected", "focus_lost");
        CHECK(onMain([&] { return b->commits.empty() && a->commits.size() == 2; }));
        step("focus change: nothing injected into the new field, commit rejected");

        // 5. 焦点回到原输入框:恢复显示最新文本
        daemon.start("s5");
        daemon.preedit("s5", 1, "先说一半");
        CHECK(waitFor([&] { return b->preedit == "先说一半"; }));
        onMain([&] {
            b->focusOut();
            return 0;
        });
        daemon.expectStatus("s5", "suspended", "focus_lost");
        daemon.preedit("s5", 2, "先说一半,再说另一半");
        onMain([&] {
            b->focusIn();
            return 0;
        });
        daemon.expectStatus("s5", "resumed");
        CHECK(waitFor([&] { return b->preedit == "先说一半,再说另一半"; }));
        daemon.commit("s5", "先说一半,再说另一半");
        daemon.expectStatus("s5", "committed");
        CHECK(onMain([&] { return b->commits == std::vector<std::string>{"先说一半,再说另一半"}; }));
        step("focus returns: resumed with latest text");

        // 6. 键盘干预:撤掉 Preedit,后续快照不再覆盖;修饰键不算
        daemon.start("s6");
        daemon.preedit("s6", 1, "语音内容");
        CHECK(waitFor([&] { return b->preedit == "语音内容"; }));
        onMain([&] {
            fcitx::KeyEvent shift(b.get(), fcitx::Key(FcitxKey_Shift_L));
            b->keyEvent(shift);
            return 0;
        });
        daemon.expectQuiet();
        CHECK(onMain([&] { return b->preedit == "语音内容"; }));
        onMain([&] {
            fcitx::KeyEvent key(b.get(), fcitx::Key(FcitxKey_a));
            b->keyEvent(key);
            return 0;
        });
        daemon.expectStatus("s6", "suspended", "user_interference");
        CHECK(onMain([&] { return b->preedit.empty(); }));
        daemon.preedit("s6", 2, "语音内容继续");
        daemon.expectQuiet();
        CHECK(onMain([&] { return b->preedit.empty(); }));
        daemon.cancel("s6");
        step("keyboard interference stops preedit updates");

        // 7. 密码框:不显示、不提交
        onMain([&] {
            b->focusOut();
            pw->focusIn();
            return 0;
        });
        daemon.start("s7");
        daemon.preedit("s7", 1, "不该出现在密码框");
        daemon.expectStatus("s7", "suspended", "focus_lost");
        daemon.commit("s7", "不该出现在密码框");
        daemon.expectStatus("s7", "rejected", "focus_lost");
        CHECK(onMain([&] { return pw->preedit.empty() && pw->commits.empty(); }));
        step("password field is never touched");

        // 8. 会话开始时没有焦点:等第一个获得焦点的输入框
        onMain([&] {
            pw->focusOut();
            return 0;
        });
        daemon.start("s8");
        daemon.preedit("s8", 1, "等焦点");
        daemon.expectStatus("s8", "suspended", "focus_lost");
        onMain([&] {
            a->focusIn();
            return 0;
        });
        daemon.expectStatus("s8", "resumed");
        CHECK(waitFor([&] { return a->preedit == "等焦点"; }));
        step("no focus at start: binds to the first focused field");

        // 9. 桌面壳断开:未提交内容作废;约 2 秒后自动重连并恢复工作
        daemon.drop();
        CHECK(waitFor([&] { return a->preedit.empty(); }));
        daemon.accept(8000);
        daemon.start("s9");
        daemon.preedit("s9", 1, "重连之后");
        CHECK(waitFor([&] { return a->preedit == "重连之后"; }));
        daemon.commit("s9", "重连之后");
        daemon.expectStatus("s9", "committed");
        CHECK(onMain([&] { return a->commits.back() == "重连之后"; }));
        step("daemon disconnect clears preedit; auto-reconnect works");

        // 10. 垃圾输入不崩溃;一次性会话(便签重发:start + commit,无 preedit)
        daemon.send(json::array({1, 2, 3}));
        CHECK(::write(daemon.conn, "not json\n", 9) == 9);
        daemon.start("s10");
        daemon.commit("s10", "便签重发");
        daemon.expectStatus("s10", "committed");
        CHECK(onMain([&] { return a->commits.back() == "便签重发"; }));
        step("garbage tolerated; one-shot commit works");

        // 11. 输入框被销毁(应用关闭):不崩溃,提交被拒绝
        daemon.start("s11");
        daemon.preedit("s11", 1, "应用要关了");
        CHECK(waitFor([&] { return a->preedit == "应用要关了"; }));
        onMain([&] {
            a.reset();
            return 0;
        });
        daemon.commit("s11", "应用要关了");
        json last;
        do {
            last = daemon.nextStatus();
            CHECK(!last.is_null());
        } while (last.value("status", "") == "suspended");
        CHECK(last.value("status", "") == "rejected");
        step("destroyed input context is handled");

        onMain([&] {
            b.reset();
            pw.reset();
            dispatcher.detach();
            instance.exit();
            return 0;
        });
    });

    instance.exec();
    script.join();
    ::unlink(sock.c_str());
    std::fprintf(stderr, "PASS fcitx5 voice module integration test\n");
    return 0;
}
