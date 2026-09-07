// input:  Persisted connection, Android service lifecycle
// output: Permission-gated remoteMessaging foreground owner
// pos:    Native background notification service entry point
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

class NotificationService : Service() {
    private lateinit var state: NotificationState
    private lateinit var presenter: NotificationPresenter
    private var reconciler: Reconciler? = null
    private var lease = -1L

    override fun onCreate() {
        super.onCreate()
        state = NotificationState.get(this)
        presenter = NotificationPresenter(this, state)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = synchronized(state) {
        presenter.channels()
        if (!state.connection.ready || !presenter.canRun()) {
            stopListening()
            stopSelf()
            return@synchronized START_NOT_STICKY
        }
        if (reconciler != null && lease == state.generation.current()) {
            reconciler?.resume()
            return@synchronized START_STICKY
        }
        runCatching { startListening() }.onFailure { stopListening(); stopSelf() }
        if (state.running) START_STICKY else START_NOT_STICKY
    }

    private fun startListening() {
        stopListening()
        lease = state.generation.current()
        val notification = presenter.summary(null)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NotificationPresenter.SERVICE_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else {
            startForeground(NotificationPresenter.SERVICE_ID, notification)
        }
        active = this
        state.running = true
        reconciler = Reconciler(state, presenter, lease, state.connection) {
            stopListening()
            presenter.clear()
            stopSelf()
        }.also { it.start() }
    }

    private fun stopListening() {
        reconciler?.close()
        reconciler = null
        if (active === this) { active = null; state.running = false }
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    override fun onDestroy() {
        synchronized(state) { stopListening() }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private var active: NotificationService? = null

        // Called under NotificationState's lock. A visible WebView may configure
        // repeatedly; do not enqueue redundant Android service starts on resume.
        fun resumeIfRunning(): Boolean {
            val service = active ?: return false
            if (service.lease != service.state.generation.current()) return false
            val reconciler = service.reconciler ?: return false
            reconciler.resume()
            return true
        }

        // Called under NotificationState's lock when invalidating the owner.
        fun stop(context: Context) {
            active?.stopListening()
            context.stopService(Intent(context, NotificationService::class.java))
        }
    }
}
