// input:  Persisted JSON, scoped notification targets
// output: Durable issued targets, pending taps and dedupe state
// pos:    Pure notification and action bookkeeping
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal data class Issued(val action: Action, val tag: String, val summary: Boolean) {
    fun json(): JSONObject = JSONObject().put("action", action.json())
        .put("tag", tag).put("summary", summary)
}
internal data class SeenAlert(val owner: String, val routeId: String)

internal class ActionLedger(saved: String = "{}") {
    val issued = linkedMapOf<String, Issued>()
    val pending = linkedMapOf<String, Action>()
    val seen = linkedMapOf<String, SeenAlert>()
    val completions = linkedSetOf<String>()
    var completionBaseline = false
        private set

    init {
        val json = JSONObject(saved)
        Protocol.objects(json.optJSONArray("issued") ?: JSONArray()).forEach {
            val route = Issued(Action.parse(it.getJSONObject("action")), it.getString("tag"), it.getBoolean("summary"))
            issued[route.action.actionId] = route
        }
        Protocol.objects(json.optJSONArray("pending") ?: JSONArray()).forEach {
            val action = Action.parse(it)
            pending[action.actionId] = action
        }
        Protocol.objects(json.optJSONArray("seen") ?: JSONArray()).forEach {
            seen[it.getString("key")] = SeenAlert(it.getString("owner"), it.getString("routeId"))
        }
        val decided = json.optJSONArray("completions") ?: JSONArray()
        (0 until decided.length()).forEach { completions.add(decided.getString(it)) }
        completionBaseline = json.optBoolean("completionBaseline", false)
    }

    // Deciding a whole snapshot is what establishes the history baseline: without it a
    // later refresh would treat every retained execution as a fresh completion.
    fun remember(ids: List<String>) {
        completionBaseline = true
        ids.forEach { completions.remove(it); completions.add(it) }
        while (completions.size > Completions.MEMORY) completions.remove(completions.first())
    }

    fun capture(routeId: String, scope: String): Action? {
        val route = issued[routeId] ?: return null
        if (scope.isEmpty() || route.action.scope != scope) return null
        val action = if (route.summary) route.action.copy(actionId = UUID.randomUUID().toString()) else route.action
        pending[action.actionId] = action
        if (!route.summary) issued.remove(routeId)
        return action
    }

    fun ack(actionId: String) { pending.remove(actionId) }

    fun json(): String = JSONObject()
        .put("issued", JSONArray(issued.values.map { it.json() }))
        .put("pending", JSONArray(pending.values.map { it.json() }))
        .put("seen", JSONArray(seen.map { (key, value) ->
            JSONObject().put("key", key).put("owner", value.owner).put("routeId", value.routeId)
        }))
        .put("completions", JSONArray(completions.toList()))
        .put("completionBaseline", completionBaseline).toString()

    fun clear() {
        issued.clear()
        pending.clear()
        seen.clear()
        completions.clear()
        completionBaseline = false
    }
}

internal class Generation {
    private var value = 0L
    fun next(): Long { value += 1; return value }
    fun current(): Long = value
    fun accepts(candidate: Long): Boolean = candidate == value
}
