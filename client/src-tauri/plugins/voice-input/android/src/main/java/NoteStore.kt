package online.hengheng.polyphony.voiceinput

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.util.UUID

/**
 * @param delivered 是否已发送到电脑(仅本机标记;别的设备写的便签视为 true,不显示提示)
 * @param synced    是否已上传到账号(服务端)
 */
data class Note(
    val id: String,
    val text: String,
    val createdAt: Long,
    val delivered: Boolean,
    val synced: Boolean
)

/** 服务端返回的一条便签。 */
data class RemoteNote(val id: String, val text: String, val createdAt: Long)

/**
 * 语音便签的本机缓存(docs/voice-input.md §6)。便签属于账号、存在服务端、全端共用;
 * 这里是离线可用的副本:新写的先落本机(synced=0),联网后由 NoteSync 补传;
 * 离线删除记入 pending_deletes,联网后补删。保留天数是账号设置,本机镜像一份用于离线清理。
 */
class NoteStore(context: Context, owner: String) :
    SQLiteOpenHelper(context.applicationContext, "voice_notes.db", null, 2) {

    private val prefs = context.applicationContext
        .getSharedPreferences("voice_input", Context.MODE_PRIVATE)

    init {
        // 缓存绑定登录设备:换账号/重新登录后清空,旧账号的便签不能串到新账号(更不能被补传上去)
        if (prefs.getString(KEY_OWNER, null) != owner) {
            writableDatabase.execSQL("DELETE FROM notes")
            writableDatabase.execSQL("DELETE FROM pending_deletes")
            prefs.edit()
                .putString(KEY_OWNER, owner)
                .remove(KEY_RETENTION)
                .remove(KEY_RETENTION_DIRTY)
                .remove(KEY_TARGET)
                .apply()
        }
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE notes (" +
                "id TEXT PRIMARY KEY, " +
                "text TEXT NOT NULL, " +
                "created_at INTEGER NOT NULL, " +
                "delivered INTEGER NOT NULL DEFAULT 0, " +
                "synced INTEGER NOT NULL DEFAULT 0)"
        )
        db.execSQL("CREATE INDEX notes_created_at ON notes(created_at)")
        db.execSQL("CREATE TABLE pending_deletes (id TEXT PRIMARY KEY)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // v1(仅本机、自增 id)从未发布,直接重建
        db.execSQL("DROP TABLE IF EXISTS notes")
        db.execSQL("DROP TABLE IF EXISTS pending_deletes")
        onCreate(db)
    }

    var retentionDays: Int
        get() = prefs.getInt(KEY_RETENTION, DEFAULT_RETENTION_DAYS)
        set(value) {
            prefs.edit().putInt(KEY_RETENTION, value).apply()
        }

    /** 本机改过保留天数但还没传到服务端。 */
    var retentionDirty: Boolean
        get() = prefs.getBoolean(KEY_RETENTION_DIRTY, false)
        set(value) {
            prefs.edit().putBoolean(KEY_RETENTION_DIRTY, value).apply()
        }

    /** 上次选择的目标电脑(设备 id);多台接收端在线时用。 */
    var targetDevice: String?
        get() = prefs.getString(KEY_TARGET, null)
        set(value) {
            prefs.edit().putString(KEY_TARGET, value).apply()
        }

    fun add(text: String, delivered: Boolean, now: Long = System.currentTimeMillis()): Note {
        val note = Note(UUID.randomUUID().toString(), text, now, delivered, synced = false)
        writableDatabase.insert("notes", null, ContentValues().apply {
            put("id", note.id)
            put("text", note.text)
            put("created_at", note.createdAt)
            put("delivered", if (delivered) 1 else 0)
            put("synced", 0)
        })
        purgeExpired(now)
        return note
    }

    private fun setFlag(id: String, column: String) {
        writableDatabase.update(
            "notes", ContentValues().apply { put(column, 1) }, "id = ?", arrayOf(id)
        )
    }

    fun markDelivered(id: String) = setFlag(id, "delivered")
    fun markSynced(id: String) = setFlag(id, "synced")

    /** 本机删除并记一笔待补删(服务端删除幂等,从未上传过的也无妨)。 */
    fun delete(id: String) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("notes", "id = ?", arrayOf(id))
            db.insertWithOnConflict(
                "pending_deletes", null, ContentValues().apply { put("id", id) },
                SQLiteDatabase.CONFLICT_IGNORE
            )
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun pendingDeletes(): List<String> {
        val out = ArrayList<String>()
        readableDatabase.rawQuery("SELECT id FROM pending_deletes", null).use { c ->
            while (c.moveToNext()) out.add(c.getString(0))
        }
        return out
    }

    fun clearPendingDelete(id: String) {
        writableDatabase.delete("pending_deletes", "id = ?", arrayOf(id))
    }

    fun unsynced(): List<Note> = query("synced = 0", null)

    /** 旧 → 新(像聊天记录一样向下追加);query 非空时按子串过滤。 */
    fun list(query: String = ""): List<Note> {
        val q = query.trim()
        if (q.isEmpty()) return query(null, null)
        val escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return query("text LIKE ? ESCAPE '\\'", arrayOf("%$escaped%"))
    }

    private fun query(where: String?, args: Array<String>?): List<Note> {
        val out = ArrayList<Note>()
        readableDatabase.query(
            "notes", arrayOf("id", "text", "created_at", "delivered", "synced"),
            where, args, null, null, "created_at ASC, id ASC"
        ).use { c ->
            while (c.moveToNext()) {
                out.add(Note(c.getString(0), c.getString(1), c.getLong(2), c.getInt(3) != 0, c.getInt(4) != 0))
            }
        }
        return out
    }

    /**
     * 用服务端的完整列表替换本机「已同步」的部分:别的设备新增的出现、别的设备删除的消失。
     * 本机未上传的(synced=0)与待补删的不受影响。
     */
    fun replaceSynced(remote: List<RemoteNote>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val delivered = HashMap<String, Boolean>()
            val localOnly = HashSet<String>()
            db.rawQuery("SELECT id, delivered, synced FROM notes", null).use { c ->
                while (c.moveToNext()) {
                    if (c.getInt(2) != 0) delivered[c.getString(0)] = c.getInt(1) != 0
                    else localOnly.add(c.getString(0))
                }
            }
            val tombstones = HashSet<String>()
            db.rawQuery("SELECT id FROM pending_deletes", null).use { c ->
                while (c.moveToNext()) tombstones.add(c.getString(0))
            }
            db.delete("notes", "synced = 1", null)
            for (n in remote) {
                if (n.id in tombstones || n.id in localOnly) continue
                db.insertWithOnConflict("notes", null, ContentValues().apply {
                    put("id", n.id)
                    put("text", n.text)
                    put("created_at", n.createdAt)
                    put("delivered", if (delivered[n.id] ?: true) 1 else 0)
                    put("synced", 1)
                }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun purgeExpired(now: Long = System.currentTimeMillis()): Int {
        val days = retentionDays
        if (days <= 0) return 0
        val cutoff = now - days * 24L * 3600_000L
        // 过期即删,不记待补删:服务端按同一保留期自行清理
        return writableDatabase.delete("notes", "created_at < ?", arrayOf(cutoff.toString()))
    }

    companion object {
        const val DEFAULT_RETENTION_DAYS = 30
        private const val KEY_OWNER = "owner_device"
        private const val KEY_RETENTION = "retention_days"
        private const val KEY_RETENTION_DIRTY = "retention_dirty"
        private const val KEY_TARGET = "target_device"
    }
}
