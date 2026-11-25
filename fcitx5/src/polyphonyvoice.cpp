#include "polyphonyvoice.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcitx-utils/capabilityflags.h>
#include <fcitx-utils/log.h>
#include <fcitx-utils/textformatflags.h>
#include <fcitx/addonmanager.h>
#include <fcitx/inputpanel.h>
#include <fcitx/text.h>
#include <fcitx/userinterface.h>
#include <nlohmann/json.hpp>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

namespace polyphony {

FCITX_DEFINE_LOG_CATEGORY(voice_log, "polyphonyvoice");
#define VOICE_DEBUG() FCITX_LOGC(::polyphony::voice_log, Debug)
#define VOICE_INFO() FCITX_LOGC(::polyphony::voice_log, Info)

namespace {

constexpr uint64_t kReconnectUsec = 2 * 1000 * 1000;
/// 单行上限:桌面壳一条事件最多携带 4000 字符文本(JSON 转义后仍远小于此)
constexpr size_t kMaxLine = 256 * 1024;

/// 诊断:文本的 UTF-8 字节数 + FNV-1a 32 摘要(与手机/服务端/桌面壳同一算法),绝不记文本本身
std::string textMeta(const std::string &text) {
    uint32_t h = 0x811c9dc5u;
    for (unsigned char c : text) {
        h ^= c;
        h *= 0x01000193u;
    }
    char buf[48];
    std::snprintf(buf, sizeof(buf), "bytes=%zu h=%08x", text.size(), h);
    return buf;
}

std::string sid8(const std::string &id) { return id.substr(0, 8); }

std::string stringField(const nlohmann::json &obj, const char *key) {
    auto it = obj.find(key);
    return it != obj.end() && it->is_string() ? it->get<std::string>() : std::string();
}

} // namespace

// ---------------------------------------------------------------- 生命周期

VoiceModule::VoiceModule(fcitx::Instance *instance)
    : instance_(instance), socketPath_(resolveSocketPath()) {
    using fcitx::EventType;
    using fcitx::EventWatcherPhase;

    handlers_.emplace_back(instance_->watchEvent(
        EventType::InputContextFocusOut, EventWatcherPhase::PreInputMethod, [this](fcitx::Event &event) {
            onFocusOut(static_cast<fcitx::InputContextEvent &>(event).inputContext());
        }));
    handlers_.emplace_back(instance_->watchEvent(
        EventType::InputContextFocusIn, EventWatcherPhase::PostInputMethod, [this](fcitx::Event &event) {
            onFocusIn(static_cast<fcitx::InputContextEvent &>(event).inputContext());
        }));
    handlers_.emplace_back(instance_->watchEvent(
        EventType::InputContextKeyEvent, EventWatcherPhase::PreInputMethod,
        [this](fcitx::Event &event) { onKey(static_cast<fcitx::KeyEvent &>(event)); }));

    // 桌面壳不一定在跑(或没开接收开关):连不上就每 2 秒再试,连上后断开同理
    reconnectTimer_ = instance_->eventLoop().addTimeEvent(
        CLOCK_MONOTONIC, fcitx::now(CLOCK_MONOTONIC), 0, [this](fcitx::EventSourceTime *, uint64_t) {
            if (socketDead_ || fd_ < 0) {
                closeSocket();
                if (!tryConnect()) {
                    scheduleReconnect();
                }
            }
            return true;
        });
}

VoiceModule::~VoiceModule() {
    endSession(true);
    closeSocket();
}

std::string VoiceModule::resolveSocketPath() {
    // 与桌面壳 voice_bridge.rs 的 socket_path() 同一规则
    if (const char *override = std::getenv("POLYPHONY_VOICE_SOCKET"); override && *override) {
        return override;
    }
    if (const char *runtime = std::getenv("XDG_RUNTIME_DIR"); runtime && *runtime) {
        return std::string(runtime) + "/polyphony-voice.sock";
    }
    std::string cache;
    if (const char *xdg = std::getenv("XDG_CACHE_HOME"); xdg && *xdg) {
        cache = xdg;
    } else if (const char *home = std::getenv("HOME"); home && *home) {
        cache = std::string(home) + "/.cache";
    } else {
        return {};
    }
    return cache + "/online.hengheng.polyphony/polyphony-voice.sock";
}

// ---------------------------------------------------------------- socket

bool VoiceModule::tryConnect() {
    sockaddr_un addr{};
    if (socketPath_.empty() || socketPath_.size() >= sizeof(addr.sun_path)) {
        return false;
    }
    int fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) {
        return false;
    }
    addr.sun_family = AF_UNIX;
    std::memcpy(addr.sun_path, socketPath_.c_str(), socketPath_.size() + 1);
    if (::connect(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0) {
        ::close(fd);
        return false;
    }
    fd_ = fd;
    socketDead_ = false;
    inbuf_.clear();
    io_ = instance_->eventLoop().addIOEvent(
        fd_, fcitx::IOEventFlag::In, [this](fcitx::EventSourceIO *, int, fcitx::IOEventFlags) {
            onReadable();
            return true;
        });
    VOICE_INFO() << "connected to Polyphony desktop";
    return true;
}

void VoiceModule::closeSocket() {
    io_.reset();
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
    }
    socketDead_ = false;
    inbuf_.clear();
}

void VoiceModule::scheduleReconnect() {
    reconnectTimer_->setNextInterval(kReconnectUsec);
    reconnectTimer_->setOneShot();
}

void VoiceModule::onReadable() {
    char buf[8192];
    for (;;) {
        ssize_t n = ::read(fd_, buf, sizeof(buf));
        if (n > 0) {
            inbuf_.append(buf, static_cast<size_t>(n));
            size_t pos;
            while ((pos = inbuf_.find('\n')) != std::string::npos) {
                std::string line = inbuf_.substr(0, pos);
                inbuf_.erase(0, pos + 1);
                if (!line.empty()) {
                    handleLine(line);
                }
            }
            if (inbuf_.size() <= kMaxLine) {
                continue;
            }
            // 没有换行的超长数据:对端不是我们的桌面壳,断开
        } else if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return;
        } else if (n < 0 && errno == EINTR) {
            continue;
        }
        // EOF / 错误 / 超长行:桌面壳退出或关闭了接收。未提交的内容作废。
        // 不在 IO 回调里销毁事件源自身:先停用,由重连定时器回收并重连。
        VOICE_INFO() << "disconnected from Polyphony desktop";
        endSession(true);
        io_->setEnabled(false);
        socketDead_ = true;
        scheduleReconnect();
        return;
    }
}

void VoiceModule::sendStatus(const std::string &sessionId, const char *status, const char *reason) {
    if (fd_ < 0 || socketDead_) {
        return;
    }
    nlohmann::json msg = {{"type", "status"}, {"session_id", sessionId}, {"status", status}};
    if (reason) {
        msg["reason"] = reason;
    }
    VOICE_INFO() << "status -> " << status << (reason ? std::string(" reason=") + reason : std::string())
                 << " sid=" << sid8(sessionId);
    std::string line = msg.dump();
    line.push_back('\n');
    // 状态行很短;写不进去(对端卡住)就丢弃,不阻塞输入法主循环
    [[maybe_unused]] ssize_t ignored = ::send(fd_, line.data(), line.size(), MSG_NOSIGNAL | MSG_DONTWAIT);
}

void VoiceModule::handleLine(const std::string &line) {
    auto msg = nlohmann::json::parse(line, nullptr, /*allow_exceptions=*/false);
    if (!msg.is_object()) {
        return;
    }
    const std::string type = stringField(msg, "type");
    const std::string sessionId = stringField(msg, "session_id");
    if (type == "hello" || sessionId.empty()) {
        return;
    }
    VOICE_INFO() << "recv " << type << " sid=" << sid8(sessionId)
                 << (msg.contains("text") ? " " + textMeta(stringField(msg, "text")) : std::string())
                 << " active=" << active_ << " bound=" << bound_ << " shown=" << shown_
                 << " suspended=" << suspended_ << " interfered=" << interfered_;
    if (type == "session.start") {
        startSession(sessionId);
    } else if (type == "preedit.update") {
        updatePreedit(sessionId, stringField(msg, "text"));
    } else if (type == "session.commit") {
        commit(sessionId, stringField(msg, "text"));
    } else if (type == "session.cancel") {
        cancel(sessionId);
    }
}

// ---------------------------------------------------------------- 会话

void VoiceModule::startSession(const std::string &sessionId) {
    if (active_ && sessionId_ == sessionId) {
        return; // 重复声明(桌面壳重发):保持现状
    }
    endSession(true); // 被新会话顶掉的旧内容作废
    active_ = true;
    sessionId_ = sessionId;
    usableTarget(); // 会话开始时有焦点的输入框即目标;此刻没有焦点则等第一个获得焦点的
}

void VoiceModule::endSession(bool clearShown) {
    if (clearShown && shown_) {
        if (auto *ic = target_.get()) {
            render(ic, "");
        }
    }
    active_ = false;
    sessionId_.clear();
    text_.clear();
    bound_ = false;
    target_.unwatch();
    shown_ = false;
    suspended_ = false;
    interfered_ = false;
}

fcitx::InputContext *VoiceModule::usableTarget() {
    if (!bound_) {
        auto *focused = instance_->lastFocusedInputContext();
        if (!focused || !focused->hasFocus()) {
            return nullptr;
        }
        target_ = focused->watch();
        bound_ = true;
        VOICE_DEBUG() << "bound to ic=" << focused << " program=" << focused->program()
                      << " frontend=" << focused->frontend()
                      << " preedit-capable=" << focused->capabilityFlags().test(fcitx::CapabilityFlag::Preedit);
    }
    auto *ic = target_.get();
    if (!ic || !ic->hasFocus()) {
        return nullptr;
    }
    // 密码框:既不显示也不提交
    if (ic->capabilityFlags().test(fcitx::CapabilityFlag::Password)) {
        return nullptr;
    }
    return ic;
}

void VoiceModule::render(fcitx::InputContext *ic, const std::string &text) {
    fcitx::Text preedit;
    if (!text.empty()) {
        // DontCommit:失焦/切换输入法时 Fcitx 默认会把 Preedit 自动提交到原输入框;
        // 语音会话的文本只在手机点「发送」时提交,失焦时应当只是暂停
        preedit.append(text, fcitx::TextFormatFlags{fcitx::TextFormatFlag::Underline,
                                                    fcitx::TextFormatFlag::DontCommit});
        preedit.setCursor(static_cast<int>(text.size())); // 光标在末尾(字节偏移)
    }
    if (ic->capabilityFlags().test(fcitx::CapabilityFlag::Preedit)) {
        ic->inputPanel().setClientPreedit(preedit);
        ic->updatePreedit();
    } else {
        // 应用不支持内嵌 Preedit:显示在输入法自己的候选面板里
        ic->inputPanel().setPreedit(preedit);
        ic->updateUserInterface(fcitx::UserInterfaceComponent::InputPanel);
    }
    shown_ = !text.empty();
}

void VoiceModule::suspend(const char *reason) {
    if (shown_) {
        if (auto *ic = target_.get()) {
            render(ic, "");
        }
    }
    shown_ = false;
    sendStatus(sessionId_, "suspended", reason);
}

void VoiceModule::updatePreedit(const std::string &sessionId, const std::string &text) {
    if (!active_ || sessionId_ != sessionId) {
        startSession(sessionId);
    }
    text_ = text;
    if (interfered_) {
        return;
    }
    auto *ic = usableTarget();
    if (!ic) {
        if (!suspended_) {
            suspended_ = true;
            suspend("focus_lost");
        }
        return;
    }
    suspended_ = false;
    render(ic, text_);
}

void VoiceModule::commit(const std::string &sessionId, const std::string &text) {
    if (!active_ || sessionId_ != sessionId) {
        startSession(sessionId);
    }
    auto *ic = usableTarget();
    VOICE_INFO() << "commit sid=" << sid8(sessionId) << " " << textMeta(text) << " target=" << ic
                 << (ic ? std::string(" program=") + ic->program() + " frontend=" + ic->frontend() : std::string());
    if (!ic) {
        // 目标不在焦点上:绝不把文字打到别的应用里。文本仍在手机便签里,可重新发送。
        sendStatus(sessionId, "rejected", "focus_lost");
        endSession(true);
        return;
    }
    render(ic, "");
    if (!text.empty()) {
        ic->commitString(text);
    }
    sendStatus(sessionId, "committed");
    endSession(false);
}

void VoiceModule::cancel(const std::string &sessionId) {
    if (active_ && sessionId_ == sessionId) {
        endSession(true);
    }
}

// ---------------------------------------------------------------- 焦点与键盘保护

void VoiceModule::onFocusOut(fcitx::InputContext *ic) {
    VOICE_DEBUG() << "focus out ic=" << ic << " program=" << ic->program() << " target=" << target_.get();
    if (!active_ || !bound_ || target_.get() != ic || suspended_) {
        return;
    }
    suspended_ = true;
    suspend("focus_lost");
}

void VoiceModule::onFocusIn(fcitx::InputContext *ic) {
    VOICE_DEBUG() << "focus in ic=" << ic << " program=" << ic->program() << " frontend=" << ic->frontend()
                  << " target=" << target_.get() << " bound=" << bound_;
    if (!active_) {
        return;
    }
    if (bound_ && target_.get() != ic) {
        return; // 焦点去了别的输入框:保持暂停,不跟过去
    }
    if (!bound_ && !suspended_) {
        return; // 会话还没产生文本,等 preedit.update 时再绑定
    }
    auto *target = usableTarget();
    if (!target) {
        return;
    }
    suspended_ = false;
    sendStatus(sessionId_, "resumed");
    if (!interfered_ && !text_.empty()) {
        render(target, text_);
    }
}

void VoiceModule::onKey(fcitx::KeyEvent &event) {
    if (!active_ || !shown_ || interfered_ || event.isRelease() || event.inputContext() != target_.get()) {
        return;
    }
    if (event.key().isModifier()) {
        return;
    }
    // 用户开始用键盘输入:撤掉我们的 Preedit,把输入框还给用户;按键本身照常交给输入法
    VOICE_INFO() << "keyboard interference key=" << event.key().toString();
    interfered_ = true;
    suspend("user_interference");
}

fcitx::AddonInstance *VoiceModuleFactory::create(fcitx::AddonManager *manager) {
    return new VoiceModule(manager->instance());
}

} // namespace polyphony

FCITX_ADDON_FACTORY(polyphony::VoiceModuleFactory);
