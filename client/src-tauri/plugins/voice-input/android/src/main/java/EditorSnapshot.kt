package online.hengheng.polyphony.voiceinput

import android.content.Context
import android.text.Selection
import android.view.inputmethod.BaseInputConnection
import android.widget.EditText

/** 编辑器状态快照;offset 全部是 UTF-16 code unit(Android Selection API 原生单位)。 */
data class EditorSnapshot(
    val text: String,
    val selectionStart: Int,
    val selectionEnd: Int,
    val composingStart: Int?,
    val composingEnd: Int?
) {
    companion object {
        /** 必须在主线程调用。composing span 是辅助信息:输入法不暴露时为 null,不影响同步。 */
        fun capture(editText: EditText): EditorSnapshot {
            val editable = editText.text
            val cs = BaseInputConnection.getComposingSpanStart(editable)
            val ce = BaseInputConnection.getComposingSpanEnd(editable)
            val hasComposing = cs >= 0 && ce >= 0
            return EditorSnapshot(
                text = editable.toString(),
                selectionStart = Selection.getSelectionStart(editable).coerceAtLeast(0),
                selectionEnd = Selection.getSelectionEnd(editable).coerceAtLeast(0),
                composingStart = if (hasComposing) minOf(cs, ce) else null,
                composingEnd = if (hasComposing) maxOf(cs, ce) else null
            )
        }
    }
}

/** 光标/选区变化也要触发快照(TextWatcher 只管文本)。 */
class WatchedEditText(context: Context) : EditText(context) {
    // 父类构造期间就会回调 onSelectionChanged,此时字段尚未初始化(为 null),安全调用即可
    var onSelection: (() -> Unit)? = null

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        super.onSelectionChanged(selStart, selEnd)
        @Suppress("UNNECESSARY_SAFE_CALL")
        onSelection?.invoke()
    }
}
