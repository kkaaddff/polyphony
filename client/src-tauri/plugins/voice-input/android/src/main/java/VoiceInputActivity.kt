package online.hengheng.polyphony.voiceinput

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/**
 * 原生语音输入页(docs/voice-input.md)。
 * 不做 ASR:只观察输入法(微信输入法等)写进 EditText 的文本变化,把「当前会话的完整文本」
 * 作为全量快照发到电脑;电脑端整体替换 Preedit,「发送」时一次性提交。
 * 每次发送同时在本机追加一条便签(可搜索、按保留天数自动清理)。
 */
class VoiceInputActivity : Activity(), SyncClient.Listener {

    private lateinit var str: Strings
    private lateinit var store: NoteStore
    private lateinit var client: SyncClient
    private lateinit var noteSync: NoteSync

    private lateinit var editor: WatchedEditText
    private lateinit var statusView: TextView
    private lateinit var searchField: EditText
    private lateinit var listView: ListView
    private lateinit var emptyView: TextView
    private val adapter = NoteAdapter()
    private val timeFormat = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())

    // ---- 会话状态(主线程独占) ----
    private var sessionId: String? = null
    private var seq = 0L
    private var revision = 0L
    private var lastSent: EditorSnapshot? = null
    /** 程序自身改写 EditText(清空等)期间置位,避免把自己的修改当成输入回环同步 */
    private var programmatic = false
    private var needsResume = false

    private var receivers: List<Peer> = emptyList()
    private var target: String? = null
    private var connState = ConnState.OFFLINE
    /** 最近一次会话事件的提示(已输入/暂停等);连接状态变化时让位给连接提示 */
    private var sessionHint: String? = null

    private val flush = Runnable { flushSnapshot() }
    private var lastFlushAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        str = Strings(intent.getStringExtra(EXTRA_LOCALE) ?: "zh")
        val server = intent.getStringExtra(EXTRA_SERVER).orEmpty()
        val token = intent.getStringExtra(EXTRA_TOKEN).orEmpty()
        // 便签缓存绑定登录设备(凭据形如 poly_d_<deviceId>_<secret>,只取 deviceId 段作归属标识)
        store = NoteStore(this, token.removePrefix("poly_d_").substringBefore('_'))
        store.purgeExpired()
        client = SyncClient(server, token, this)
        noteSync = NoteSync(server, token, store) { reloadNotes(scrollToEnd = false) }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(buildUi())
        reloadNotes(scrollToEnd = true)
        renderStatus()
        editor.requestFocus()
    }

    override fun onStart() {
        super.onStart()
        client.start()
        noteSync.sync() // 拉取别的设备上的便签,补传离线时写下的
    }

    override fun onStop() {
        super.onStop()
        // 文本留在 EditText 里;回到前台重连后 onState(CONNECTED) 会重发最新快照
        client.stop()
    }

    override fun onDestroy() {
        editor.removeCallbacks(flush)
        client.stop()
        noteSync.shutdown()
        store.close()
        super.onDestroy()
    }

    override fun finish() {
        // 页面关闭 = 放弃未发送内容:趁连接还在通知电脑清掉 Preedit
        cancelSession()
        super.finish()
    }

    // ---------------------------------------------------------------- UI

    private fun dp(v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun rounded(color: Int, radiusDp: Int, strokeColor: Int? = null) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radiusDp).toFloat()
        if (strokeColor != null) setStroke(dp(1), strokeColor)
    }

    private fun textButton(label: String, onClick: () -> Unit) = TextView(this).apply {
        text = label
        textSize = 14f
        setTextColor(COLOR_ACCENT)
        gravity = Gravity.CENTER
        minWidth = dp(44)
        minHeight = dp(44)
        setPadding(dp(10), 0, dp(10), 0)
        setOnClickListener { onClick() }
    }

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(COLOR_BG)
        }

        // 顶栏:返回 | 标题 | 搜索 | 保留天数
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), 0, dp(4), 0)
        }
        header.addView(textButton("‹ ${str.back}") { finish() })
        header.addView(TextView(this).apply {
            text = str.title
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(COLOR_TEXT)
            gravity = Gravity.CENTER
            maxLines = 1
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(textButton(str.search) { toggleSearch() })
        header.addView(textButton(str.retention) { showRetentionDialog() })
        root.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)))

        searchField = EditText(this).apply {
            hint = str.searchHint
            textSize = 15f
            inputType = InputType.TYPE_CLASS_TEXT
            maxLines = 1
            background = rounded(Color.WHITE, 10, COLOR_BORDER)
            setPadding(dp(12), dp(8), dp(12), dp(8))
            visibility = View.GONE
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun afterTextChanged(s: Editable?) = reloadNotes(scrollToEnd = true)
            })
        }
        root.addView(searchField, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { setMargins(dp(12), 0, dp(12), dp(8)) })

        // 便签流:旧 → 新,向下追加
        emptyView = TextView(this).apply {
            textSize = 14f
            setTextColor(COLOR_MUTED)
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
        }
        listView = ListView(this).apply {
            divider = null
            isStackFromBottom = true
            transcriptMode = ListView.TRANSCRIPT_MODE_NORMAL
            clipToPadding = false
            setPadding(0, dp(4), 0, dp(4))
            adapter = this@VoiceInputActivity.adapter
        }
        val listBox = android.widget.FrameLayout(this)
        listBox.addView(listView, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        listBox.addView(emptyView, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        root.addView(listBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        // 状态条(连接/目标电脑/会话事件);可点:选目标电脑或恢复会话
        statusView = TextView(this).apply {
            textSize = 12f
            setTextColor(COLOR_MUTED)
            setPadding(dp(16), dp(6), dp(16), dp(6))
            setOnClickListener { onStatusClick() }
        }
        root.addView(statusView)

        // 输入区
        val composer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        editor = WatchedEditText(this).apply {
            hint = str.inputHint
            textSize = 17f
            setTextColor(COLOR_TEXT)
            setHintTextColor(COLOR_MUTED)
            gravity = Gravity.TOP or Gravity.START
            minLines = 3
            maxLines = 8
            inputType = InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            filters = arrayOf(InputFilter.LengthFilter(MAX_TEXT_CHARS))
            background = rounded(COLOR_BG, 12, COLOR_BORDER)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    VoiceLog.d("edit start=$start removed=$before added=$count ${VoiceLog.meta(s?.toString() ?: "")}" +
                        " programmatic=$programmatic")
                }
                override fun afterTextChanged(s: Editable?) = scheduleFlush()
            })
            onSelection = { scheduleFlush() }
        }
        composer.addView(editor, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL or Gravity.END
            setPadding(0, dp(8), 0, 0)
        }
        actions.addView(textButton(str.clear) { cancelSession(); clearEditor() }.apply {
            setTextColor(COLOR_MUTED)
        })
        actions.addView(TextView(this).apply {
            text = str.send
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            background = rounded(COLOR_ACCENT, 22)
            minWidth = dp(96)
            minHeight = dp(44)
            setOnClickListener { finishSession() }
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { leftMargin = dp(8) })
        composer.addView(actions)
        root.addView(composer)

        // edge-to-edge:系统栏与软键盘 inset 都垫成 root 的 padding(键盘弹出时输入区贴在键盘上沿)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        return root
    }

    private fun toggleSearch() {
        val show = searchField.visibility != View.VISIBLE
        searchField.visibility = if (show) View.VISIBLE else View.GONE
        if (show) {
            searchField.requestFocus()
        } else {
            searchField.setText("")
            editor.requestFocus()
        }
    }

    private fun showRetentionDialog() {
        val options = intArrayOf(1, 7, 30, 90, 365, 0)
        val labels = options.map { if (it == 0) str.forever else str.days(it) }.toTypedArray()
        val current = options.indexOf(store.retentionDays).coerceAtLeast(0)
        AlertDialog.Builder(this)
            .setTitle(str.retentionTitle)
            .setSingleChoiceItems(labels, current) { dialog, which ->
                // 保留天数是账号设置:本机先生效,再同步到服务端(全端一致)
                store.retentionDays = options[which]
                store.retentionDirty = true
                store.purgeExpired()
                reloadNotes(scrollToEnd = false)
                noteSync.sync()
                dialog.dismiss()
            }
            .show()
    }

    /**
     * 长按预览:底部面板展示全文(可上下滚动),三个操作 —— 删除(需确认)/ 转文档 / 发送到电脑。
     * 复制交给系统文本选择(正文可选中)。
     */
    private fun showNotePreview(note: Note) {
        val dialog = android.app.Dialog(this)
        dialog.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                val r = dp(22).toFloat()
                cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
            }
            setPadding(dp(20), dp(10), dp(20), dp(16))
        }
        box.addView(View(this).apply {
            background = rounded(COLOR_BORDER, 3)
        }, LinearLayout.LayoutParams(dp(40), dp(4)).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            bottomMargin = dp(12)
        })
        box.addView(TextView(this).apply {
            text = timeFormat.format(Date(note.createdAt))
            textSize = 12f
            setTextColor(COLOR_MUTED)
        })
        val body = TextView(this).apply {
            text = note.text
            textSize = 16f
            setTextColor(COLOR_TEXT)
            setLineSpacing(dp(3).toFloat(), 1f)
            setTextIsSelectable(true)
            setPadding(0, dp(8), 0, dp(8))
        }
        val scroller = android.widget.ScrollView(this).apply {
            isVerticalScrollBarEnabled = true
            addView(body)
        }
        // 正文最多占屏高的 55%,更长时在面板内滚动
        val maxH = (resources.displayMetrics.heightPixels * 0.55f).toInt()
        box.addView(scroller, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        scroller.viewTreeObserver.addOnGlobalLayoutListener {
            if (scroller.height > maxH) scroller.layoutParams = scroller.layoutParams.apply { height = maxH }
        }

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(12), 0, 0)
        }
        fun action(label: String, fg: Int, bg: Int, onClick: () -> Unit) = TextView(this).apply {
            text = label
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(fg)
            gravity = Gravity.CENTER
            background = rounded(bg, 14)
            minHeight = dp(48)
            setOnClickListener { onClick() }
        }
        val lp = { LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginStart = dp(4); marginEnd = dp(4) } }
        row.addView(action(str.delete, COLOR_DANGER, COLOR_DANGER_BG) {
            confirmDelete(note, onDeleted = { dialog.dismiss() })
        }, lp())
        row.addView(action(str.toDoc, COLOR_TEXT, COLOR_BG) {
            dialog.dismiss()
            convertToDoc(note)
        }, lp())
        row.addView(action(str.resend, Color.WHITE, COLOR_ACCENT) {
            dialog.dismiss()
            resendNote(note)
        }, lp())
        box.addView(row)

        dialog.setContentView(box)
        dialog.window?.apply {
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setGravity(Gravity.BOTTOM)
            setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
            setWindowAnimations(android.R.style.Animation_InputMethod)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setDimAmount(0.4f)
        }
        // 面板底部垫出导航栏高度
        ViewCompat.setOnApplyWindowInsetsListener(box) { v, insets ->
            val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            v.setPadding(dp(20), dp(10), dp(20), dp(16) + nav.bottom)
            insets
        }
        dialog.show()
    }

    /** 转文档:交回 App 主界面新建文档(以便签为正文),本页关闭。 */
    private fun convertToDoc(note: Note) {
        setResult(RESULT_OK, android.content.Intent().putExtra(RESULT_TO_DOC, note.text))
        super.finish() // 不走本类 finish():那里会取消输入区的会话
        cancelSession()
    }

    private fun reloadNotes(scrollToEnd: Boolean) {
        val query = searchField.text.toString()
        adapter.items = store.list(query)
        adapter.notifyDataSetChanged()
        emptyView.text = if (query.isBlank()) str.emptyNotes else str.emptySearch
        emptyView.visibility = if (adapter.items.isEmpty()) View.VISIBLE else View.GONE
        if (scrollToEnd && adapter.items.isNotEmpty()) listView.setSelection(adapter.items.size - 1)
    }

    /** 删除确认(参照 iOS 信息:底部操作面板,红色「删除」+「取消」)。取消时 [onCancel] 让卡片回弹。 */
    private fun confirmDelete(note: Note, onCancel: () -> Unit = {}, onDeleted: () -> Unit = {}) {
        var done = false
        val dialog = AlertDialog.Builder(this)
            .setMessage(str.deleteConfirm)
            .setNegativeButton(str.cancel, null)
            .setPositiveButton(str.delete) { _, _ ->
                done = true
                store.delete(note.id)
                reloadNotes(scrollToEnd = false)
                noteSync.sync()
                onDeleted()
            }
            .create()
        dialog.setOnDismissListener { if (!done) onCancel() }
        dialog.show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.setTextColor(COLOR_DANGER)
    }

    /**
     * 行内手势(参照 iOS 信息列表):
     * - 往右滑 → 左侧露出蓝色「发送」胶囊,越拉越长;超过阈值松手 = 直接发送到电脑(无需确认),卡片回弹;
     * - 往左滑 → 右侧露出红色「删除」胶囊;松手停在露出状态,再点胶囊或继续拉过阈值 = 弹删除确认;
     *   确认后卡片向左滑出并收起,取消则回弹;
     * - 长按 → 预览面板(全文可滚动 + 删除/转文档/发送);
     * - 轻点 → 预览面板;竖向为主的移动交还给列表滚动。
     */
    private fun attachSwipe(row: FrameLayout, card: View, sendPill: View, deletePill: View) {
        val cfg = android.view.ViewConfiguration.get(this)
        val slop = cfg.scaledTouchSlop
        val longPressMs = android.view.ViewConfiguration.getLongPressTimeout().toLong()
        val trigger = dp(120).toFloat()     // 「直接触发」阈值
        val openWidth = dp(88).toFloat()    // 左滑松手后停留的露出宽度
        var downX = 0f
        var downY = 0f
        var startTx = 0f
        var swiping = false
        var longPressed = false
        var armed = false                   // 已越过阈值(震动一次)
        val longPress = Runnable {
            if (!swiping) {
                longPressed = true
                card.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
                (card.tag as? Note)?.let { showNotePreview(it) }
            }
        }

        fun layoutPills(tx: Float) {
            // 形态:露出宽度 < 圆直径时从小圆点长到半高圆;之后高度固定,两端半圆中间矩形向外拉长
            shapePill(sendPill, if (tx > 0) tx else 0f, hot = tx >= trigger, accent = true)
            shapePill(deletePill, if (tx < 0) -tx else 0f, hot = -tx >= trigger, accent = false)
        }

        fun settle(to: Float, then: (() -> Unit)? = null) {
            val anim = android.animation.ValueAnimator.ofFloat(card.translationX, to).setDuration(220)
            anim.interpolator = android.view.animation.DecelerateInterpolator(1.6f)
            anim.addUpdateListener {
                val v = it.animatedValue as Float
                card.translationX = v
                layoutPills(v)
            }
            anim.addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(a: android.animation.Animator) { then?.invoke() }
            })
            anim.start()
            // 松手后仍露出按钮:duang 一下
            if (to < 0f) duang(deletePill) else if (card.translationX > dp(PILL_H_DP)) duang(sendPill)
        }

        fun collapseAndRemove(note: Note) {
            // 确认删除后:卡片滑出屏幕,行高收起
            settle(-row.width.toFloat()) {
                val h = row.height
                val anim = android.animation.ValueAnimator.ofInt(h, 0).setDuration(200)
                anim.addUpdateListener {
                    row.layoutParams = row.layoutParams.apply { height = it.animatedValue as Int }
                    row.requestLayout()
                }
                anim.addListener(object : android.animation.AnimatorListenerAdapter() {
                    override fun onAnimationEnd(a: android.animation.Animator) {
                        row.layoutParams = row.layoutParams.apply { height = ViewGroup.LayoutParams.WRAP_CONTENT }
                        card.translationX = 0f
                        layoutPills(0f)
                        store.delete(note.id)
                        reloadNotes(scrollToEnd = false)
                        noteSync.sync()
                    }
                })
                anim.start()
            }
        }

        fun askDelete(note: Note) {
            settle(-openWidth)
            confirmDeleteOnly(note, onCancel = { settle(0f) }, onConfirm = { collapseAndRemove(note) })
        }

        deletePill.setOnClickListener { (card.tag as? Note)?.let { askDelete(it) } }

        card.setOnTouchListener { v, e ->
            val note = v.tag as? Note
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY
                    startTx = card.translationX
                    swiping = false; longPressed = false; armed = false
                    v.isPressed = true
                    v.postDelayed(longPress, longPressMs)
                    true
                }
                android.view.MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX
                    val dy = e.rawY - downY
                    if (!swiping && !longPressed) {
                        if (Math.abs(dy) > slop && Math.abs(dy) > Math.abs(dx)) {
                            // 竖向滚动:交还列表
                            v.removeCallbacks(longPress)
                            v.isPressed = false
                            v.parent?.requestDisallowInterceptTouchEvent(false)
                            return@setOnTouchListener false
                        }
                        if (Math.abs(dx) > slop) {
                            swiping = true
                            v.removeCallbacks(longPress)
                            v.isPressed = false
                            v.parent?.requestDisallowInterceptTouchEvent(true)
                            (v.parent as? View)?.parent?.requestDisallowInterceptTouchEvent(true)
                        }
                    }
                    if (swiping) {
                        // 超出阈值后加阻尼,手感更「拉得动」
                        var tx = startTx + dx
                        val limit = trigger * 1.4f
                        if (Math.abs(tx) > limit) tx = Math.signum(tx) * (limit + (Math.abs(tx) - limit) * 0.3f)
                        card.translationX = tx
                        layoutPills(tx)
                        val hot = Math.abs(tx) >= trigger
                        if (hot != armed) {
                            armed = hot
                            if (hot) v.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
                        }
                    }
                    true
                }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                    v.removeCallbacks(longPress)
                    v.isPressed = false
                    val up = e.actionMasked == android.view.MotionEvent.ACTION_UP
                    val tx = card.translationX
                    when {
                        longPressed -> settle(0f)
                        swiping && up && note != null && tx >= trigger -> {
                            // 右滑过阈值:直接发送(不确认),回弹
                            settle(0f)
                            resendNote(note, toast = true)
                        }
                        swiping && up && note != null && tx <= -trigger -> askDelete(note)
                        swiping && up && tx < -openWidth / 2 -> settle(-openWidth) // 停在露出「删除」
                        swiping -> settle(0f)
                        up && note != null && Math.abs(startTx) > 1f -> settle(0f) // 露出态轻点 = 收起
                        up && note != null -> showNotePreview(note)
                        else -> settle(0f)
                    }
                    swiping = false
                    true
                }
                else -> false
            }
        }
    }

    /** 只确认、不删数据(删数据由调用方在动画结束后做);取消/返回键都算取消。 */
    private fun confirmDeleteOnly(note: Note, onCancel: () -> Unit, onConfirm: () -> Unit) {
        var done = false
        val dialog = AlertDialog.Builder(this)
            .setMessage(str.deleteConfirm)
            .setNegativeButton(str.cancel, null)
            .setPositiveButton(str.delete) { _, _ -> done = true; onConfirm() }
            .create()
        dialog.setOnDismissListener { if (!done) onCancel() }
        dialog.show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.setTextColor(COLOR_DANGER)
    }

    private inner class NoteAdapter : BaseAdapter() {
        var items: List<Note> = emptyList()
        override fun getCount() = items.size
        override fun getItem(position: Int) = items[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val row = (convertView as? FrameLayout) ?: FrameLayout(this@VoiceInputActivity).apply {
                setPadding(dp(12), dp(4), dp(12), dp(4))
                clipChildren = true
                clipToPadding = true
                // 底层:左「发送」胶囊、右「删除」胶囊(宽度随位移拉长)
                val send = pill(str.resend, COLOR_ACCENT_SOFT, 0)
                addView(send, FrameLayout.LayoutParams(1, 1, Gravity.START or Gravity.CENTER_VERTICAL))
                val del = pill(str.delete, COLOR_DANGER_SOFT, 1)
                addView(del, FrameLayout.LayoutParams(1, 1, Gravity.END or Gravity.CENTER_VERTICAL))
                // 卡片:固定高度,正文最多两行,超出省略号
                val card = LinearLayout(context).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER_VERTICAL
                    background = android.graphics.drawable.StateListDrawable().apply {
                        addState(intArrayOf(android.R.attr.state_pressed), rounded(COLOR_PRESSED, 14, COLOR_BORDER))
                        addState(intArrayOf(), rounded(Color.WHITE, 14, COLOR_BORDER))
                    }
                    setPadding(dp(14), dp(10), dp(14), dp(10))
                }
                card.addView(TextView(context).apply {
                    textSize = 15f
                    setTextColor(COLOR_TEXT)
                    setLineSpacing(dp(2).toFloat(), 1f)
                    maxLines = 2
                    ellipsize = android.text.TextUtils.TruncateAt.END
                })
                card.addView(TextView(context).apply {
                    textSize = 11f
                    setTextColor(COLOR_MUTED)
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.END
                    setPadding(0, dp(4), 0, 0)
                })
                addView(card, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(CARD_HEIGHT_DP)))
                attachSwipe(this, card, send, del)
            }
            val card = row.getChildAt(2) as LinearLayout
            val note = items[position]
            card.tag = note
            card.translationX = 0f
            row.getChildAt(0).visibility = View.INVISIBLE
            row.getChildAt(1).visibility = View.INVISIBLE
            (card.getChildAt(0) as TextView).text = note.text.replace('\n', ' ')
            (card.getChildAt(1) as TextView).text = buildString {
                append(timeFormat.format(Date(note.createdAt)))
                if (!note.synced) append("  ·  ").append(str.notSynced)
                if (!note.delivered) append("  ·  ").append(str.notDelivered)
            }
            return row
        }
    }

    /**
     * 滑动露出的按钮:一个胶囊容器(图标 + 文字)。尺寸由 [shapePill] 按露出宽度实时计算。
     * 子 0 = 图标(ImageView,矢量绘制),子 1 = 文字。
     */
    private fun pill(label: String, color: Int, iconKind: Int) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER
        background = rounded(color, PILL_H_DP)
        visibility = View.INVISIBLE
        clipToOutline = true
        addView(android.widget.ImageView(context).apply {
            setImageDrawable(PillIcon(iconKind, dp(18).toFloat()))
        }, LinearLayout.LayoutParams(dp(18), dp(18)))
        addView(TextView(context).apply {
            text = label
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            maxLines = 1
            setPadding(dp(6), 0, 0, 0)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    /** 圆点 → 半高圆 → 固定半高拉长;小时只显示图标,放得下文字才显示文字。 */
    private fun shapePill(pill: View, reveal: Float, hot: Boolean, accent: Boolean) {
        val gap = dp(PILL_GAP_DP)
        val room = (reveal - gap * 2).coerceAtLeast(0f)
        val full = dp(PILL_H_DP).toFloat()
        val size = room.coerceIn(dp(PILL_DOT_DP).toFloat(), full)
        val width = maxOf(size, room)
        val box = pill as LinearLayout
        box.visibility = if (room > dp(2)) View.VISIBLE else View.INVISIBLE
        box.getChildAt(0).visibility = if (size >= dp(22)) View.VISIBLE else View.GONE
        box.getChildAt(1).visibility = if (width >= dp(96)) View.VISIBLE else View.GONE
        (box.background as GradientDrawable).apply {
            setColor(if (accent) (if (hot) COLOR_ACCENT else COLOR_ACCENT_SOFT) else (if (hot) COLOR_DANGER else COLOR_DANGER_SOFT))
            cornerRadius = size / 2f
        }
        box.layoutParams = (box.layoutParams as FrameLayout.LayoutParams).apply {
            this.width = width.toInt().coerceAtLeast(1)
            this.height = size.toInt().coerceAtLeast(1)
            if (accent) leftMargin = gap else rightMargin = gap
        }
        box.pivotX = if (accent) 0f else width
        box.pivotY = size / 2f
        box.requestLayout()
    }

    /** 松手时的「duang」:先压扁再弹回(弹簧插值)。 */
    private fun duang(v: View) {
        if (v.visibility != View.VISIBLE) return
        v.animate().cancel()
        v.scaleX = 1.12f
        v.scaleY = 0.86f
        v.animate().scaleX(1f).scaleY(1f).setDuration(420)
            .setInterpolator(android.view.animation.OvershootInterpolator(3.2f)).start()
    }

    /** 1.75px 线性图标(与 Web 同一套路径):0 = 发送(上传箭头),1 = 删除(垃圾桶)。24 视口按尺寸缩放。 */
    private class PillIcon(private val kind: Int, private val px: Float) : android.graphics.drawable.Drawable() {
        private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            style = android.graphics.Paint.Style.STROKE
            color = Color.WHITE
            // 24 视口下的线宽(随 canvas.scale 等比缩放,18dp 图标约 1.4dp 线)
            strokeWidth = 1.9f
            strokeCap = android.graphics.Paint.Cap.ROUND
            strokeJoin = android.graphics.Paint.Join.ROUND
        }
        private val path = android.graphics.Path().apply {
            if (kind == 0) {
                moveTo(21f, 15f); lineTo(21f, 19f); quadTo(21f, 21f, 19f, 21f); lineTo(5f, 21f); quadTo(3f, 21f, 3f, 19f); lineTo(3f, 15f)
                moveTo(17f, 8f); lineTo(12f, 3f); lineTo(7f, 8f)
                moveTo(12f, 3f); lineTo(12f, 15f)
            } else {
                moveTo(3f, 6f); lineTo(21f, 6f)
                moveTo(19f, 6f); lineTo(19f, 20f); quadTo(19f, 22f, 17f, 22f); lineTo(7f, 22f); quadTo(5f, 22f, 5f, 20f); lineTo(5f, 6f)
                moveTo(8f, 6f); lineTo(8f, 4f); quadTo(8f, 2f, 10f, 2f); lineTo(14f, 2f); quadTo(16f, 2f, 16f, 4f); lineTo(16f, 6f)
                moveTo(10f, 11f); lineTo(10f, 17f)
                moveTo(14f, 11f); lineTo(14f, 17f)
            }
        }
        override fun draw(canvas: android.graphics.Canvas) {
            val s = px / 24f
            canvas.save()
            canvas.translate(bounds.left.toFloat(), bounds.top.toFloat())
            canvas.scale(s, s)
            canvas.drawPath(path, paint)
            canvas.restore()
        }
        override fun setAlpha(alpha: Int) { paint.alpha = alpha }
        override fun setColorFilter(cf: android.graphics.ColorFilter?) { paint.colorFilter = cf }
        @Deprecated("Deprecated in Java")
        override fun getOpacity() = android.graphics.PixelFormat.TRANSLUCENT
        override fun getIntrinsicWidth() = px.toInt()
        override fun getIntrinsicHeight() = px.toInt()
    }

    // ---------------------------------------------------------------- 状态条

    private fun targetLabel(): String? = receivers.firstOrNull { it.deviceId == target }?.label

    private fun renderStatus() {
        val label = targetLabel()
        val base = when (connState) {
            ConnState.CONNECTING -> str.connecting
            ConnState.OFFLINE -> str.offline
            ConnState.UNAUTHORIZED -> str.unauthorized
            ConnState.CONNECTED -> when {
                receivers.isEmpty() -> str.noReceiver
                label == null -> str.pickTarget
                else -> str.readyFor(label)
            }
        }
        val ready = connState == ConnState.CONNECTED && label != null
        val text = if (needsResume) str.unknownSession else if (ready) sessionHint ?: base else base
        statusView.text = text
        statusView.setTextColor(
            if (needsResume || !ready) COLOR_WARN else COLOR_OK
        )
    }

    private fun onStatusClick() {
        if (needsResume) {
            needsResume = false
            resyncSession()
            renderStatus()
            return
        }
        if (receivers.size > 1) {
            val labels = receivers.map { it.label }.toTypedArray()
            AlertDialog.Builder(this)
                .setTitle(str.chooseTarget)
                .setItems(labels) { _, which ->
                    val chosen = receivers[which].deviceId
                    store.targetDevice = chosen
                    client.send(JSONObject().put("type", "target").put("device_id", chosen))
                }
                .show()
        }
    }

    // ---------------------------------------------------------------- 会话

    private fun scheduleFlush() {
        if (programmatic) return
        // 节流 + 保证尾帧:微信输入法一次识别更新会连发 setComposingText/setSelection 等多个调用,
        // 不节流时每秒可达上百个快照,超过服务端限速(60/s)后中间帧被丢 —— 若被丢的恰好是
        // 松手后的最后一帧,文本此后不再变化,电脑上就停在残缺的中间态(真机实踩)。
        // 这里最多每 MIN_FLUSH_INTERVAL_MS 发一帧,且最后一次变化之后一定会再发一帧。
        val wait = (lastFlushAt + MIN_FLUSH_INTERVAL_MS - android.os.SystemClock.uptimeMillis()).coerceAtLeast(0)
        editor.removeCallbacks(flush)
        editor.postDelayed(flush, wait)
    }

    private fun base(type: String): JSONObject =
        JSONObject().put("v", 1).put("type", type).put("session_id", sessionId).put("seq", seq++)

    private fun snapshotMessage(snap: EditorSnapshot): JSONObject =
        base("text.snapshot")
            .put("revision", revision)
            .put("text", snap.text)
            .put("selection_start", snap.selectionStart)
            .put("selection_end", snap.selectionEnd)
            .put("composing_start", snap.composingStart ?: JSONObject.NULL)
            .put("composing_end", snap.composingEnd ?: JSONObject.NULL)
            .put("timestamp_ms", System.currentTimeMillis())

    private fun flushSnapshot() {
        val snap = EditorSnapshot.capture(editor)
        if (snap == lastSent) return
        if (sessionId == null) {
            if (snap.text.isEmpty()) return
            sessionId = UUID.randomUUID().toString()
            seq = 0
            revision = 0
            needsResume = false
            sessionHint = null
            val ok = client.send(base("session.start"))
            VoiceLog.i("session.start sid=${VoiceLog.sid(sessionId)} sent=$ok conn=$connState target=${targetLabel() != null}")
        }
        // 弱网背压:发送队列积压时跳过这一帧,稍后只补最新状态(全量快照可丢中间帧)
        if (client.queuedBytes > MAX_QUEUED_BYTES) {
            VoiceLog.w("snapshot deferred: queued=${client.queuedBytes}")
            editor.removeCallbacks(flush)
            editor.postDelayed(flush, 50)
            return
        }
        revision++
        lastFlushAt = android.os.SystemClock.uptimeMillis()
        val prev = lastSent
        lastSent = snap
        val ok = client.send(snapshotMessage(snap))
        VoiceLog.i("snapshot sid=${VoiceLog.sid(sessionId)} seq=${seq - 1} rev=$revision ${VoiceLog.meta(snap.text)}" +
            " common=${VoiceLog.common(prev?.text, snap.text)} sel=${snap.selectionStart}-${snap.selectionEnd}" +
            " comp=${snap.composingStart}-${snap.composingEnd} sent=$ok")
    }

    /** 重连/会话失效后:重新声明会话并补发最新完整快照(不重放中间帧)。 */
    private fun resyncSession() {
        if (sessionId == null) return
        client.send(base("session.start"))
        val snap = EditorSnapshot.capture(editor)
        revision++
        lastSent = snap
        val ok = client.send(snapshotMessage(snap))
        VoiceLog.i("resync sid=${VoiceLog.sid(sessionId)} rev=$revision ${VoiceLog.meta(snap.text)} sent=$ok")
    }

    /** 「发送」:电脑端提交当前 Preedit;本机追加一条便签;清空输入区开始下一条。 */
    private fun finishSession() {
        editor.removeCallbacks(flush)
        val text = editor.text.toString()
        if (text.isBlank()) return
        var delivered = false
        if (client.connected && targetLabel() != null) {
            if (sessionId == null) {
                sessionId = UUID.randomUUID().toString()
                seq = 0
                revision = 0
                client.send(base("session.start"))
            }
            revision++
            // finish 自带终稿:即使末帧快照丢了,提交的也是手机上的最终文本
            delivered = client.send(base("session.finish").put("revision", revision).put("text", text))
        }
        VoiceLog.i("finish sid=${VoiceLog.sid(sessionId)} seq=${seq - 1} rev=$revision ${VoiceLog.meta(text)}" +
            " lastSnap=${lastSent?.let { VoiceLog.meta(it.text) }} common=${VoiceLog.common(lastSent?.text, text)}" +
            " comp=${EditorSnapshot.capture(editor).let { "${it.composingStart}-${it.composingEnd}" }}" +
            " delivered=$delivered conn=$connState")
        // 离线时不排队补发:过后再把旧文本注入电脑当时的焦点窗口是危险的,由用户在便签上手动「发送到电脑」
        store.add(text.trim(), delivered)
        noteSync.sync()
        sessionHint = if (delivered) null else str.savedOnly
        sessionId = null
        lastSent = null
        needsResume = false
        clearEditor()
        if (searchField.visibility == View.VISIBLE) searchField.setText("") else reloadNotes(scrollToEnd = true)
        if (!delivered) Toast.makeText(this, str.savedOnly, Toast.LENGTH_SHORT).show()
        renderStatus()
    }

    private fun cancelSession() {
        editor.removeCallbacks(flush)
        if (sessionId != null) {
            VoiceLog.i("cancel sid=${VoiceLog.sid(sessionId)}")
            client.send(base("session.cancel"))
            sessionId = null
            lastSent = null
            needsResume = false
        }
    }

    private fun clearEditor() {
        programmatic = true
        editor.text.clear()
        programmatic = false
        // 清掉输入法残留的 composing 状态,否则下一句可能接在旧候选后面
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).restartInput(editor)
    }

    /** 便签 → 电脑:一次性会话(start + finish),不经过输入区。 */
    private fun resendNote(note: Note, toast: Boolean = false) {
        if (!client.connected || targetLabel() == null) {
            Toast.makeText(this, str.noReceiver, Toast.LENGTH_LONG).show()
            return
        }
        val id = UUID.randomUUID().toString()
        client.send(JSONObject().put("v", 1).put("type", "session.start").put("session_id", id).put("seq", 0))
        val ok = client.send(
            JSONObject().put("v", 1).put("type", "session.finish").put("session_id", id)
                .put("seq", 1).put("revision", 1).put("text", note.text)
        )
        VoiceLog.i("resend note sid=${VoiceLog.sid(id)} ${VoiceLog.meta(note.text)} sent=$ok")
        if (ok && toast) Toast.makeText(this, str.sent, Toast.LENGTH_SHORT).show()
        if (ok && !note.delivered) {
            store.markDelivered(note.id)
            reloadNotes(scrollToEnd = false)
        }
    }

    // ---------------------------------------------------------------- SyncClient.Listener(主线程)

    override fun onState(state: ConnState) {
        VoiceLog.i("conn $connState -> $state")
        connState = state
        if (state == ConnState.CONNECTED) {
            store.targetDevice?.let {
                client.send(JSONObject().put("type", "target").put("device_id", it))
            }
            // 进行中的会话不在这里补发:随后到达的 peers 给出目标电脑时由 onPeers 补发
        } else {
            receivers = emptyList()
            target = null
        }
        renderStatus()
    }

    override fun onPeers(receivers: List<Peer>, target: String?) {
        VoiceLog.i("peers receivers=${receivers.size} target=${target != null}")
        val hadTarget = this.target != null
        this.receivers = receivers
        this.target = target
        // 目标电脑刚上线(或刚选定):把进行中的会话补发过去
        if (!hadTarget && target != null) resyncSession()
        renderStatus()
    }

    override fun onNotesChanged() {
        noteSync.sync() // 完成后回调里刷新列表
    }

    override fun onAck(sessionId: String, seq: Long, injected: Boolean) {
        VoiceLog.d("ack sid=${VoiceLog.sid(sessionId)} seq=$seq injected=$injected current=${sessionId == this.sessionId}")
        if (sessionId != this.sessionId) return
        val label = targetLabel() ?: return
        sessionHint = if (injected) str.liveOn(label) else str.previewOnly(label)
        renderStatus()
    }

    override fun onStatus(sessionId: String, status: String, reason: String?) {
        VoiceLog.i("status sid=${VoiceLog.sid(sessionId)} $status reason=$reason current=${sessionId == this.sessionId}")
        val current = sessionId == this.sessionId
        sessionHint = when (status) {
            "committed" -> str.committed
            "not_injected" -> str.notInjected
            "cancelled" -> str.cancelled
            "resumed" -> str.resumed
            "suspended" -> when (reason) {
                "focus_lost" -> str.suspendedFocus
                "user_interference" -> str.suspendedKeyboard
                else -> str.suspended
            }
            "unknown_session" -> {
                if (current) needsResume = true
                sessionHint
            }
            "rejected" -> when (reason) {
                "no_receiver" -> str.noReceiver
                "focus_lost" -> str.rejectedFocus
                else -> sessionHint
            }
            else -> sessionHint
        }
        renderStatus()
    }

    companion object {
        const val EXTRA_SERVER = "server"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_LOCALE = "locale"
        /** 结果:「转文档」时带回便签正文,由插件交给 WebView 新建文档 */
        const val RESULT_TO_DOC = "toDoc"
        private const val CARD_HEIGHT_DP = 76
        /** 滑动按钮:固定半高(约卡片一半)、最小圆点、与卡片/屏边的间距 */
        private const val PILL_H_DP = 40
        private const val PILL_DOT_DP = 10
        private const val PILL_GAP_DP = 10

        private const val MAX_TEXT_CHARS = 4000
        private const val MAX_QUEUED_BYTES = 64 * 1024L
        /** 快照最小间隔:20 帧/秒,远低于服务端限速,实时感不受影响 */
        private const val MIN_FLUSH_INTERVAL_MS = 50L

        private val COLOR_BG = Color.parseColor("#F5F6F8")
        private val COLOR_TEXT = Color.parseColor("#1B1C26")
        private val COLOR_MUTED = Color.parseColor("#6C6E7B")
        private val COLOR_BORDER = Color.parseColor("#E4E5EA")
        private val COLOR_ACCENT = Color.parseColor("#0277BD")
        private val COLOR_OK = Color.parseColor("#059669")
        private val COLOR_WARN = Color.parseColor("#B45309")
        private val COLOR_DANGER = Color.parseColor("#DC2626")
        private val COLOR_DANGER_SOFT = Color.parseColor("#F4A3A3")
        private val COLOR_DANGER_BG = Color.parseColor("#FDECEC")
        private val COLOR_ACCENT_SOFT = Color.parseColor("#7DB9E8")
        private val COLOR_PRESSED = Color.parseColor("#EEF0F3")
    }
}
