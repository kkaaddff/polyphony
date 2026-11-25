package online.hengheng.polyphony.voiceinput

import android.os.Handler
import android.os.Looper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 便签与服务端同步(/notes,Bearer 凭据;docs/voice-input.md §6)。单线程串行执行:
 *   1. 补删离线时删掉的  2. 补传本机未上传的(客户端 id,服务端幂等)
 *   3. 保留天数:本机改过则上传,否则以服务端为准  4. 拉取完整列表替换本机已同步部分
 * 任何一步网络失败就此打住,下次再来;本机数据不丢。日志不含便签内容与凭据。
 */
class NoteSync(
    serverUrl: String,
    private val token: String,
    private val store: NoteStore,
    private val onChanged: () -> Unit
) {
    private val base = serverUrl.trimEnd('/')
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()
    private val json = "application/json; charset=utf-8".toMediaType()

    @Volatile
    private var closed = false

    fun sync() {
        if (closed) return
        io.execute {
            try {
                run()
            } catch (e: Exception) {
                // 离线/服务器不可达:保留本机状态,下次同步再试
            }
            if (!closed) main.post { if (!closed) onChanged() }
        }
    }

    fun shutdown() {
        closed = true
        io.shutdown()
    }

    private fun request(path: String) =
        Request.Builder().url(base + path).header("Authorization", "Bearer $token")

    /** 返回 (HTTP 状态码, 响应体)。 */
    private fun call(req: Request): Pair<Int, String> =
        http.newCall(req).execute().use { it.code to (it.body?.string() ?: "") }

    private fun run() {
        for (id in store.pendingDeletes()) {
            val (code, _) = call(request("/notes/" + URLEncoder.encode(id, "UTF-8")).delete().build())
            if (code == 401) return
            if (code in 200..299) store.clearPendingDelete(id)
        }

        for (note in store.unsynced()) {
            val body = JSONObject()
                .put("id", note.id)
                .put("text", note.text)
                .put("createdAt", note.createdAt)
                .toString().toRequestBody(json)
            val (code, _) = call(request("/notes").post(body).build())
            if (code == 401) return
            // 2xx 已入库;400/409 是服务端永久拒绝(内容非法/id 冲突),不再反复重试
            if (code in 200..299 || code == 400 || code == 409) store.markSynced(note.id)
        }

        if (store.retentionDirty) {
            val body = JSONObject().put("retentionDays", store.retentionDays).toString().toRequestBody(json)
            val (code, _) = call(request("/notes/settings").put(body).build())
            if (code in 200..299 || code == 400) store.retentionDirty = false
        } else {
            val (code, text) = call(request("/notes/settings").get().build())
            if (code in 200..299) {
                store.retentionDays = JSONObject(text).optInt("retentionDays", store.retentionDays)
            }
        }

        val remote = ArrayList<RemoteNote>()
        var before = 0L
        for (page in 0 until MAX_PAGES) {
            val path = "/notes?limit=$PAGE_SIZE" + if (before > 0) "&before=$before" else ""
            val (code, text) = call(request(path).get().build())
            if (code !in 200..299) return // 拉不全就不替换,避免把本机已有的误删
            val obj = JSONObject(text)
            val arr = obj.getJSONArray("notes")
            for (i in 0 until arr.length()) {
                val n = arr.getJSONObject(i)
                remote.add(RemoteNote(n.getString("id"), n.getString("text"), n.getLong("createdAt")))
            }
            if (!obj.optBoolean("hasMore") || arr.length() == 0) break
            before = remote.last().createdAt
        }
        store.replaceSynced(remote)
        store.purgeExpired()
    }

    companion object {
        private const val PAGE_SIZE = 500
        private const val MAX_PAGES = 10
    }
}
