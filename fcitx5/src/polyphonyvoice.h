// Polyphony 远程语音输入 · Fcitx5 模块(docs/voice-input.md §5)。
//
// 作为 Unix Socket 客户端连到 Polyphony 桌面壳,把它转来的会话事件映射到当前焦点的输入上下文:
//   preedit.update → 整体替换 Client Preedit;session.commit → 清 Preedit 并 commitString。
// 做成「模块」而不是输入法引擎:不需要切换输入法,与拼音等引擎并存。
//
// 线程模型:没有线程。Socket 的读事件和重连定时器都挂在 Fcitx 主事件循环上,
// 所有 InputContext 操作都发生在主线程;输入上下文只以弱引用持有(应用关闭后自动失效)。
#ifndef POLYPHONY_VOICE_H
#define POLYPHONY_VOICE_H

#include <fcitx-utils/event.h>
#include <fcitx-utils/handlertable.h>
#include <fcitx-utils/trackableobject.h>
#include <fcitx/addonfactory.h>
#include <fcitx/addoninstance.h>
#include <fcitx/event.h>
#include <fcitx/inputcontext.h>
#include <fcitx/instance.h>
#include <memory>
#include <string>
#include <vector>

namespace polyphony {

class VoiceModule : public fcitx::AddonInstance {
public:
    explicit VoiceModule(fcitx::Instance *instance);
    ~VoiceModule() override;

private:
    // ---- socket ----
    static std::string resolveSocketPath();
    bool tryConnect();
    void closeSocket();
    void scheduleReconnect();
    void onReadable();
    void handleLine(const std::string &line);
    void sendStatus(const std::string &sessionId, const char *status, const char *reason = nullptr);

    // ---- 会话 ----
    void startSession(const std::string &sessionId);
    void updatePreedit(const std::string &sessionId, const std::string &text);
    void commit(const std::string &sessionId, const std::string &text);
    void cancel(const std::string &sessionId);
    void endSession(bool clearShown);

    /// 绑定的输入上下文:存在、仍有焦点且不是密码框时返回,否则 nullptr。尚未绑定时绑定当前焦点。
    fcitx::InputContext *usableTarget();
    void render(fcitx::InputContext *ic, const std::string &text);
    void suspend(const char *reason);

    void onFocusOut(fcitx::InputContext *ic);
    void onFocusIn(fcitx::InputContext *ic);
    void onKey(fcitx::KeyEvent &event);

    fcitx::Instance *instance_;
    std::string socketPath_;
    int fd_ = -1;
    bool socketDead_ = false;
    std::string inbuf_;
    std::unique_ptr<fcitx::EventSourceIO> io_;
    std::unique_ptr<fcitx::EventSourceTime> reconnectTimer_;
    std::vector<std::unique_ptr<fcitx::HandlerTableEntry<fcitx::EventHandler>>> handlers_;

    bool active_ = false;
    std::string sessionId_;
    std::string text_;
    /// 是否已选定目标输入上下文(选定后不再改绑:焦点换到别的应用也不跟过去)
    bool bound_ = false;
    fcitx::TrackableObjectReference<fcitx::InputContext> target_;
    /// 目标上当前是否显示着我们的 Preedit
    bool shown_ = false;
    /// 因失焦暂停(焦点回到目标后恢复)
    bool suspended_ = false;
    /// 用户在电脑上敲了键盘:本会话不再显示 Preedit(避免覆盖用户正在输入的内容)
    bool interfered_ = false;
};

class VoiceModuleFactory : public fcitx::AddonFactory {
public:
    fcitx::AddonInstance *create(fcitx::AddonManager *manager) override;
};

} // namespace polyphony

#endif
