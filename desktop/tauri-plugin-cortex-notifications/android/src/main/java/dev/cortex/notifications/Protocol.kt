// input:  JSON snapshots, HTTPS connection configuration
// output: Connection, Action, Session, Alert, Protocol
// pos:    Pure notification identities and snapshot decoding
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

internal fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
    .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

internal data class Connection(
    val serverUrl: String, val token: String, val enabled: Boolean, val locale: String,
) {
    val scope: String get() = if (serverUrl.isEmpty()) "" else digest("$serverUrl\n$token")
    val ready: Boolean get() = enabled && serverUrl.isNotEmpty() && token.isNotEmpty()
    override fun toString(): String = "Connection(scope=$scope, enabled=$enabled)"
    fun disconnected(): Connection = copy(serverUrl = "", token = "")

    companion object {
        fun create(url: String, token: String, enabled: Boolean, locale: String): Connection {
            val parsed = url.toHttpUrl()
            require(parsed.isHttps && parsed.username.isEmpty() && parsed.password.isEmpty())
            require(parsed.query == null && parsed.fragment == null)
            require(token.isNotBlank() && token.all { it.code in 32..126 })
            return Connection(parsed.toString().trimEnd('/'), token, enabled, locale)
        }
    }
}

internal data class Action(
    val scope: String, val kind: String, val sessionId: String? = null,
    val projectId: String? = null, val approvalId: String? = null,
    val actionId: String = UUID.randomUUID().toString(),
) {
    fun json(): JSONObject = JSONObject().put("actionId", actionId).put("scope", scope)
        .put("kind", kind).put("sessionId", sessionId).put("projectId", projectId)
        .put("approvalId", approvalId)

    companion object {
        fun parse(json: JSONObject): Action = Action(
            json.getString("scope"), json.getString("kind"), json.optional("sessionId"),
            json.optional("projectId"), json.optional("approvalId"), json.getString("actionId"),
        )
    }
}

internal fun JSONObject.optional(key: String): String? =
    if (isNull(key)) null else getString(key).takeIf { it.isNotBlank() }

internal data class Session(
    val id: String, val projectId: String?, val running: Boolean, val awaiting: Boolean,
    val background: Boolean = false, val name: String? = null,
)
internal data class Alert(
    val key: String, val owner: String, val kind: String,
    val sessionId: String? = null, val projectId: String? = null, val approvalId: String? = null,
)

internal object Protocol {
    fun queryData(body: String): Any = JSONObject(body).getJSONObject("result").get("data")

    fun sessions(body: String): List<Session> = objects(JSONArray(body))
        .filter { it.optString("origin", "direct") == "direct" }
        .map {
            Session(requiredId(it, "sessionId"), it.optional("projectId"),
                boolean(it, "running"), boolean(it, "awaitingInput"),
                it.optBoolean("backgroundRunning", false), it.optional("label") ?: it.optional("name"))
        }.groupBy { it.id }.values.map { rows ->
            // Count IDs, not rows. An inactive duplicate must not hide another
            // row's live turn/background hold or pending interaction.
            rows.first().copy(running = rows.any { it.running }, awaiting = rows.any { it.awaiting },
                background = rows.any { it.background })
        }

    // Only identity and outcome are read. Prompts, labels and final agent output
    // stay on the server: a background notification never carries transcript text.
    fun executions(body: String): List<ExecutionRow> = objects(JSONArray(body)).map {
        // optString disagrees on JSON null between Android and the JVM test artifact.
        ExecutionRow(requiredId(it, "id"), it.optional("sessionId"), it.optional("finishedAt") ?: "")
    }

    fun executionDetail(body: JSONObject): ExecutionDetail = ExecutionDetail(
        body.getString("status"), body.getString("kind"), body.optional("threadId"),
        body.optional("sessionId"), body.optional("projectId"))

    fun interactions(session: Session, body: JSONObject): List<Alert> =
        listOf("askUser", "plan").mapNotNull { kind -> interaction(session, body, kind) }

    private fun interaction(session: Session, body: JSONObject, kind: String): Alert? {
        require(body.has(kind))
        if (body.isNull(kind)) return null
        val requestId = requiredId(body.getJSONObject(kind), "requestId")
        val key = digest(JSONArray(listOf(session.id, requestId, kind)).toString())
        return Alert(key, "session:${session.id}", kind, session.id, session.projectId)
    }

    fun approvals(body: String): List<Alert> = objects(JSONArray(body)).map {
        val id = requiredId(it, "id")
        require(it.getString("status") == "pending")
        Alert(digest("approval:$id"), "approvals", "approval", approvalId = id)
    }.distinctBy { it.key }

    private fun boolean(json: JSONObject, key: String): Boolean {
        val value = json.get(key)
        require(value is Boolean)
        return value
    }

    private fun requiredId(json: JSONObject, key: String): String =
        json.getString(key).also { require(it.isNotBlank()) }

    fun objects(array: JSONArray): List<JSONObject> =
        (0 until array.length()).map { array.getJSONObject(it) }
}
