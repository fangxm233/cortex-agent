// input:  App-private storage, connection and action ledger
// output: Durable connection state, completion ownership and generation gate
// pos:    Shared plugin and service state owner
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import android.content.Context
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File

// All mutations, notification side effects and generation checks share this lock.
// The no-backup directory prevents credentials or old tap capabilities migrating.
internal class NotificationState private constructor(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "cortex-notifications.json"))
    val generation = Generation()
    var connection = Connection("", "", true, "en")
        private set
    var ledger = ActionLedger()
        private set
    var running = false

    // The page declares whether it owns turn-completion notifications on every sync, so a
    // cached page that predates them silently takes them back and nothing is posted twice.
    @Volatile var completionNotifications = false

    // In-memory only: a rebuilt process suppresses nothing until the page reports again.
    @Volatile var visibleSessionId: String? = null

    init {
        runCatching {
            val json = JSONObject(file.openRead().bufferedReader().use { it.readText() })
            val enabled = json.optBoolean("enabled", true)
            val url = json.optString("serverUrl")
            connection = if (url.isBlank()) Connection("", "", enabled, json.optString("locale", "en"))
                else Connection.create(url, json.getString("token"), enabled, json.optString("locale", "en"))
            ledger = ActionLedger(json.optJSONObject("ledger")?.toString() ?: "{}")
            completionNotifications = json.optBoolean("completionNotifications", false)
        }.onFailure {
            connection = Connection("", "", true, "en")
            ledger = ActionLedger()
        }
    }

    fun configure(next: Connection): Boolean {
        val reset = connection.scope != next.scope || connection.enabled != next.enabled
        if (reset) generation.next()
        connection = next
        return reset
    }

    fun disconnect() {
        generation.next()
        connection = connection.disconnected()
    }

    fun accepts(lease: Long): Boolean = generation.accepts(lease) && connection.ready

    fun save() {
        val json = JSONObject().put("serverUrl", connection.serverUrl).put("token", connection.token)
            .put("enabled", connection.enabled).put("locale", connection.locale)
            .put("completionNotifications", completionNotifications)
            .put("ledger", JSONObject(ledger.json()))
        val stream = file.startWrite()
        try {
            stream.write(json.toString().toByteArray(Charsets.UTF_8))
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }

    companion object {
        @Volatile private var instance: NotificationState? = null
        fun get(context: Context): NotificationState = instance ?: synchronized(this) {
            instance ?: NotificationState(context.applicationContext).also { instance = it }
        }
    }
}
