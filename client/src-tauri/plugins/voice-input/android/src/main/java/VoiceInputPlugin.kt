package online.hengheng.polyphony.voiceinput

import android.app.Activity
import android.content.Intent
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class OpenArgs {
    var serverUrl: String? = null
    var token: String? = null
    var locale: String? = null
}

/**
 * JS: invoke("plugin:voice-input|open", { serverUrl, token, locale }) → 打开原生语音输入页。
 * 页面关闭时 resolve:`{ toDoc?: string }` —— 用户在便签预览里点了「转文档」时带回正文,由 WebView 新建文档。
 */
@TauriPlugin
class VoiceInputPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        val server = args.serverUrl?.trim().orEmpty()
        val token = args.token.orEmpty()
        if (server.isEmpty() || token.isEmpty()) {
            invoke.reject("serverUrl and token are required")
            return
        }
        // 凭据只经进程内显式 Intent 传给未导出的 Activity,不落盘
        val intent = Intent(activity, VoiceInputActivity::class.java)
            .putExtra(VoiceInputActivity.EXTRA_SERVER, server)
            .putExtra(VoiceInputActivity.EXTRA_TOKEN, token)
            .putExtra(VoiceInputActivity.EXTRA_LOCALE, args.locale ?: "zh")
        startActivityForResult(invoke, intent, "openResult")
    }

    @ActivityCallback
    private fun openResult(invoke: Invoke, result: ActivityResult) {
        val ret = JSObject()
        result.data?.getStringExtra(VoiceInputActivity.RESULT_TO_DOC)?.let { ret.put("toDoc", it) }
        invoke.resolve(ret)
    }
}
