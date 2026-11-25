package online.hengheng.polyphony.voiceinput

import android.util.Log

/**
 * 语音输入链路诊断日志(adb logcat -s PolyVoice)。
 * 只记元数据,绝不记文本内容:UTF-8 字节数 + 字符数 + FNV-1a 32 摘要。
 * 摘要算法与服务端 / 桌面 Rust / Fcitx5 插件一致(同一段文本在各跳的 h= 相同),
 * 用来定位文本在哪一跳被截断或改写。
 */
object VoiceLog {
    private const val TAG = "PolyVoice"

    fun d(msg: String) { Log.d(TAG, msg) }
    fun i(msg: String) { Log.i(TAG, msg) }
    fun w(msg: String) { Log.w(TAG, msg) }

    fun fnv(text: String): String {
        var h = 0x811c9dc5L
        for (b in text.toByteArray(Charsets.UTF_8)) {
            h = h xor (b.toLong() and 0xff)
            h = (h * 0x01000193L) and 0xffffffffL
        }
        return String.format("%08x", h)
    }

    fun meta(text: String): String =
        "bytes=${text.toByteArray(Charsets.UTF_8).size} chars=${text.length} h=${fnv(text)}"

    fun sid(id: String?): String = id?.take(8) ?: "-"

    /** 与上一份文本的公共前缀长度(UTF-16 单位):判断是「追加」还是「改写」。 */
    fun common(a: String?, b: String?): Int {
        if (a == null || b == null) return -1
        val n = minOf(a.length, b.length)
        var i = 0
        while (i < n && a[i] == b[i]) i++
        return i
    }
}
