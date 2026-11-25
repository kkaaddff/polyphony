package online.hengheng.polyphony.voiceinput

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class Peer(val deviceId: String, val label: String)

enum class ConnState { CONNECTING, CONNECTED, OFFLINE, UNAUTHORIZED }

/**
 * 输入通道发送端(docs/voice-input.md):WS /_input?role=sender,凭据走子协议头(与文档协同同一套)。
 * 断线指数退避重连;重连后由上层重发「最新完整快照」,这里不缓存、不重放任何中间帧。
 * 回调一律切回主线程。日志里绝不出现文本与凭据。
 */
class SyncClient(
    serverUrl: String,
    private val token: String,
    private val listener: Listener
) {
    interface Listener {
        fun onState(state: ConnState)
        fun onPeers(receivers: List<Peer>, target: String?)
        fun onAck(sessionId: String, seq: Long, injected: Boolean)
        fun onStatus(sessionId: String, status: String, reason: String?)
        /** 账号下的便签有变化(别的设备新增/删除/改保留期) */
        fun onNotesChanged()
    }

    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(8, TimeUnit.SECONDS)
        .build()
    private val url = serverUrl.trimEnd('/').replaceFirst(Regex("^http", RegexOption.IGNORE_CASE), "ws") +
        "/_input?role=sender"

    private var socket: WebSocket? = null
    private var generation = 0
    private var wanted = false
    private var backoffMs = INITIAL_BACKOFF_MS
    private var state = ConnState.OFFLINE
    private val reconnect = Runnable { open() }

    val connected: Boolean get() = state == ConnState.CONNECTED

    /** 已入队未发出的字节数(弱网背压:上层据此跳过中间快照)。 */
    val queuedBytes: Long get() = socket?.queueSize() ?: 0

    fun start() {
        if (wanted) return
        wanted = true
        backoffMs = INITIAL_BACKOFF_MS
        open()
    }

    fun stop() {
        wanted = false
        main.removeCallbacks(reconnect)
        generation++
        socket?.close(1000, null)
        socket = null
        setState(ConnState.OFFLINE)
    }

    /** 只在已连接时发送;返回是否已交给 socket。 */
    fun send(msg: JSONObject): Boolean {
        if (!connected) return false
        return socket?.send(msg.toString()) ?: false
    }

    private fun setState(next: ConnState) {
        if (state == next) return
        state = next
        listener.onState(next)
    }

    private fun open() {
        if (!wanted) return
        val gen = ++generation
        setState(ConnState.CONNECTING)
        val request = try {
            Request.Builder()
                .url(url)
                .header("Sec-WebSocket-Protocol", "polyphony.v1, auth.$token")
                .build()
        } catch (e: IllegalArgumentException) {
            setState(ConnState.OFFLINE)
            return
        }
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onMain(gen) {
                backoffMs = INITIAL_BACKOFF_MS
                setState(ConnState.CONNECTED)
            }

            override fun onMessage(webSocket: WebSocket, text: String) = onMain(gen) {
                dispatch(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                onMain(gen) { lost(code) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onMain(gen) {
                lost(code)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onMain(gen) {
                lost(0)
            }
        })
    }

    private fun onMain(gen: Int, block: () -> Unit) {
        main.post { if (gen == generation) block() }
    }

    private fun lost(code: Int) {
        generation++ // 同一条连接的后续回调(closing → closed)不再重复处理
        socket = null
        if (code == CLOSE_UNAUTHORIZED) {
            // 凭据失效/被吊销:不再重连,等用户回 App 重新登录
            wanted = false
            setState(ConnState.UNAUTHORIZED)
            return
        }
        setState(ConnState.OFFLINE)
        if (!wanted) return
        main.removeCallbacks(reconnect)
        main.postDelayed(reconnect, backoffMs)
        backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
    }

    private fun dispatch(raw: String) {
        val msg = try {
            JSONObject(raw)
        } catch (e: Exception) {
            return
        }
        when (msg.optString("type")) {
            "peers" -> {
                val arr = msg.optJSONArray("receivers")
                val peers = ArrayList<Peer>()
                if (arr != null) {
                    for (i in 0 until arr.length()) {
                        val o = arr.optJSONObject(i) ?: continue
                        peers.add(Peer(o.optString("device_id"), o.optString("label")))
                    }
                }
                val target = if (msg.isNull("target")) null else msg.optString("target")
                listener.onPeers(peers, target)
            }
            "notes.changed" -> listener.onNotesChanged()
            "ack" -> listener.onAck(
                msg.optString("session_id"), msg.optLong("seq"), msg.optBoolean("injected")
            )
            "session.status" -> listener.onStatus(
                msg.optString("session_id"),
                msg.optString("status"),
                if (msg.has("reason")) msg.optString("reason") else null
            )
        }
    }

    companion object {
        private const val INITIAL_BACKOFF_MS = 500L
        private const val MAX_BACKOFF_MS = 10_000L
        private const val CLOSE_UNAUTHORIZED = 4001
    }
}
