// input:  App-owned notification dismissal PendingIntents
// output: Removed issued routes without clearing pending dedupe
// pos:    Explicit dismissal lifecycle for ordinary notifications
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class NotificationDismissReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefix = "${NotificationPresenter.PREFIX}.dismiss."
        val action = intent.action ?: return
        if (!action.startsWith(prefix)) return
        val id = action.removePrefix(prefix)
        if (intent.dataString != "cortex-notification://dismiss/$id") return
        val state = NotificationState.get(context)
        synchronized(state) {
            val route = state.ledger.issued[id] ?: return
            if (route.summary || route.action.scope != state.connection.scope) return
            state.ledger.issued.remove(id)
            runCatching { state.save() }
        }
    }
}
