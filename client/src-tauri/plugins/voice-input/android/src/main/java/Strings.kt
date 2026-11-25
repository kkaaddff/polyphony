package online.hengheng.polyphony.voiceinput

/** 页面文案(zh/en);locale 由 WebView 侧传入,与 App 语言一致。 */
class Strings(locale: String) {
    private val zh = locale != "en"
    private fun s(a: String, b: String) = if (zh) a else b

    val title = s("语音输入到电脑", "Voice input to computer")
    val back = s("返回", "Back")
    val search = s("搜索", "Search")
    val searchHint = s("搜索便签", "Search notes")
    val retention = s("保留", "Keep")
    val retentionTitle = s("便签最多保留", "Keep notes for")
    val forever = s("永久", "Forever")
    fun days(n: Int) = s("$n 天", if (n == 1) "1 day" else "$n days")
    val inputHint = s(
        "点这里,用输入法的语音键说话;文字会实时出现在电脑上",
        "Tap here and dictate with your keyboard's voice key; text appears on your computer live"
    )
    val send = s("发送", "Send")
    val clear = s("清空", "Clear")
    val emptyNotes = s("还没有便签。每次「发送」都会在这里追加一条,并同步到账号下的其他设备。", "No notes yet. Every Send appends one here and syncs to your other devices.")
    val emptySearch = s("没有匹配的便签", "No matching notes")
    val notDelivered = s("未发送到电脑", "Not sent to computer")
    val notSynced = s("待同步", "Not synced yet")
    val copy = s("复制", "Copy")
    val copied = s("已复制", "Copied")
    val resend = s("发送到电脑", "Send to computer")
    val delete = s("删除", "Delete")
    val deleteConfirm = s("删除这条便签?所有设备上都会删除。", "Delete this note? It is removed on all devices.")
    val cancel = s("取消", "Cancel")
    val chooseTarget = s("选择目标电脑", "Choose a computer")
    val toDoc = s("转文档", "To doc")
    val sent = s("已发送到电脑", "Sent to computer")
    val close = s("关闭", "Close")

    val connecting = s("正在连接服务器…", "Connecting…")
    val offline = s("未连接服务器,文字先留在手机上", "Offline — text stays on this phone")
    val unauthorized = s("登录已失效,请返回 App 重新登录", "Signed out — go back and sign in again")
    val noReceiver = s(
        "没有在线的电脑:请在桌面端「设置」里开启接收远程语音输入",
        "No computer online: enable remote voice input in the desktop app's Settings"
    )
    val pickTarget = s("有多台电脑在线,点这里选择", "Several computers online — tap to choose")
    fun readyFor(label: String) = s("已连接 → $label", "Connected → $label")
    fun liveOn(label: String) = s("实时显示在 $label", "Live on $label")
    fun previewOnly(label: String) = s(
        "$label 已收到(未连接输入法插件,仅预览)",
        "$label received it (no input-method plugin, preview only)"
    )
    val committed = s("已输入到电脑", "Typed on computer")
    val notInjected = s("电脑已收到,但没有输入法插件可注入", "Received, but no input-method plugin to type it")
    val suspendedFocus = s(
        "电脑上没有检测到输入框焦点:请点一下目标输入框(新打开的窗口可能要先按一下键)",
        "No focused input field on the computer: click the target field (a newly opened window may need one key press first)"
    )
    val suspendedKeyboard = s("电脑端有键盘输入,已暂停注入", "Keyboard used on computer — paused")
    val suspended = s("电脑端已暂停注入", "Paused on computer")
    val resumed = s("电脑端已恢复", "Resumed on computer")
    val cancelled = s("已取消", "Cancelled")
    val rejectedFocus = s(
        "电脑上的光标已不在原输入框,没有输入(已存为便签,可重新发送)",
        "Cursor left the original field on the computer — not typed (saved as a note, you can resend)"
    )
    val unknownSession = s("电脑端会话已失效,点这里继续同步", "Session expired on computer — tap to resume")
    val savedOnly = s("已存为便签(未发送到电脑)", "Saved as a note (not sent to computer)")
}
