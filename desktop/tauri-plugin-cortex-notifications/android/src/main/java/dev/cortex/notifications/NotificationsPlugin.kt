// input:  Tauri Invoke commands, Activity intents, native state
// output: Notification bridge, visible session and actionPerformed events
// pos:    Android Cortex notification plugin entry point
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import android.app.Activity
import android.content.Intent
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject

@InvokeArg
class ConfigureArgs {
    lateinit var serverUrl: String
    lateinit var token: String
    var enabled: Boolean = true
    var locale: String = "en"
    var completionNotifications: Boolean = false
}

@InvokeArg
class PostArgs {
    lateinit var title: String
    lateinit var body: String
    var data: Map<String, String>? = null
}

@InvokeArg
class AckActionArgs { lateinit var actionId: String }

@InvokeArg
class VisibleSessionArgs { var sessionId: String = "" }

@TauriPlugin
class NotificationsPlugin(private val activity: Activity) : Plugin(activity) {
    private val state = NotificationState.get(activity)
    private val presenter = NotificationPresenter(activity, state)
    @Volatile private var visible = false

    override fun onPause() {
        visible = false
        state.visibleSessionId = null // Leaving the foreground ends visible suppression at once.
    }
    override fun load(webView: WebView) { capture(activity.intent) }
    override fun onNewIntent(intent: Intent) { capture(intent) }

    override fun onResume() {
        visible = true
        synchronized(state) {
            runCatching { startIfAllowed() }
        }
    }

    @Command
    fun configure(invoke: Invoke) = command(invoke, "Unable to configure notifications") {
        val args = invoke.parseArgs(ConfigureArgs::class.java)
        if (args.serverUrl.isBlank() && args.token.isBlank()) {
            require(!args.enabled)
            clearConnection() // Legacy disconnect preserves the device preference.
        } else {
            val next = Connection.create(args.serverUrl, args.token, args.enabled, args.locale)
            if (state.configure(next)) { NotificationService.stop(activity); presenter.clear() }
            state.completionNotifications = args.completionNotifications
            state.save()
            startIfAllowed()
        }
        statusJson()
    }

    @Command
    fun clear(invoke: Invoke) = command(invoke, "Unable to clear notifications") {
        clearConnection()
        JSONObject()
    }

    @Command
    fun status(invoke: Invoke) = command(invoke, "Unable to read notification status") {
        if (!presenter.canRun()) NotificationService.stop(activity)
        if (!presenter.permissionGranted()) presenter.clear()
        statusJson()
    }

    @Command
    fun post(invoke: Invoke) = command(invoke, "Unable to post notification") {
        val args = invoke.parseArgs(PostArgs::class.java)
        presenter.channels()
        presenter.post(args.title, args.body, args.data?.get("sessionId")?.takeIf { it.isNotBlank() },
            args.data?.get("projectId")?.takeIf { it.isNotBlank() })
        JSONObject()
    }

    @Command
    fun visibleSession(invoke: Invoke) = command(invoke, "Unable to record the visible session") {
        val args = invoke.parseArgs(VisibleSessionArgs::class.java)
        state.visibleSessionId = args.sessionId.takeIf { it.isNotBlank() }
        JSONObject()
    }

    @Command
    fun pendingActions(invoke: Invoke) = command(invoke, "Unable to read notification actions") {
        JSONObject().put("actions", JSONArray(state.ledger.pending.values
            .filter { it.scope == state.connection.scope }.map { it.json() }))
    }

    @Command
    fun ackAction(invoke: Invoke) = command(invoke, "Unable to acknowledge notification action") {
        state.ledger.ack(invoke.parseArgs(AckActionArgs::class.java).actionId)
        state.save()
        JSONObject()
    }

    private fun clearConnection() {
        state.disconnect()
        NotificationService.stop(activity)
        presenter.clear()
    }

    private fun startIfAllowed() {
        presenter.channels()
        if (!state.connection.ready || !presenter.canRun()) {
            NotificationService.stop(activity)
            if (!presenter.permissionGranted()) presenter.clear()
            return
        }
        if (isVisible() && !NotificationService.resumeIfRunning()) {
            ContextCompat.startForegroundService(activity, Intent(activity, NotificationService::class.java))
        }
    }

    private fun isVisible(): Boolean = visible || (activity as? LifecycleOwner)?.lifecycle
        ?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true

    private fun statusJson(): JSONObject = JSONObject().put("enabled", state.connection.enabled)
        .put("running", state.running).put("permissionGranted", presenter.permissionGranted())
        .put("scope", state.connection.scope)
        .put("completionNotifications", state.completionNotifications)

    private fun capture(intent: Intent?) {
        if (intent == null) return
        synchronized(state) {
            runCatching {
                val route = ownedRoute(intent) ?: return
                val action = state.ledger.capture(route.action.actionId, state.connection.scope) ?: return
                state.save()
                intent.action = null // Activity recreation must not recapture this tap.
                intent.data = null
                presenter.cancelTapped(route) // A summary never dismisses the FGS.
                trigger("actionPerformed", js(action.json()))
            }
        }
    }

    private fun ownedRoute(intent: Intent): Issued? {
        val prefix = "${NotificationPresenter.PREFIX}."
        val name = intent.action ?: return null
        if (!name.startsWith(prefix) || intent.component != activity.componentName) return null
        val id = name.removePrefix(prefix)
        if (intent.dataString != "cortex-notification://action/$id") return null
        return state.ledger.issued[id]?.takeIf { it.action.scope == state.connection.scope }
    }

    private fun command(invoke: Invoke, failure: String, block: () -> JSONObject) {
        synchronized(state) {
            try { invoke.resolve(js(block())) } catch (_: Exception) { invoke.reject(failure) }
        }
    }

    private fun js(json: JSONObject): JSObject = JSObject().also { result ->
        json.keys().forEach { key -> result.put(key, json.get(key)) }
    }
}
