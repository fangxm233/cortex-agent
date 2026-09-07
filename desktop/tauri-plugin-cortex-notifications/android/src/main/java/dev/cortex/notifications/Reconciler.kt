// input:  Scoped state, presenter, tRPC transport
// output: Reconciled running count and pending alerts
// pos:    Background snapshot and SSE coordination
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

internal class Reconciler(
    private val state: NotificationState,
    private val presenter: NotificationPresenter,
    private val lease: Long,
    connection: Connection,
    private val permissionLost: () -> Unit,
) {
    private val transport = CortexTransport(connection)
    private val snapshots = Executors.newSingleThreadScheduledExecutor()
    private val stream = Executors.newSingleThreadScheduledExecutor()
    private val closed = AtomicBoolean(false)
    private val queued = AtomicBoolean(false)
    private val revision = AtomicLong(0)
    @Volatile private var connected = false
    private var retrySeconds = 2L

    fun start() {
        refreshSoon()
        snapshots.scheduleWithFixedDelay({ refreshSoon() }, 60, 60, TimeUnit.SECONDS)
        stream.execute(::listen)
    }

    fun resume() {
        // Web focus/visibility and configure can all follow the same Activity
        // resume. Keep the healthy stream: cancelling it here turned each hint
        // into a disconnect and escalated the reconnect backoff to 60 seconds.
        refreshSoon()
    }

    private fun refreshSoon() {
        if (closed.get() || !queued.compareAndSet(false, true)) return
        runCatching {
            snapshots.schedule({ queued.set(false); refresh() }, 750, TimeUnit.MILLISECONDS)
        }
    }

    private fun listen() {
        if (closed.get()) return
        val started = System.nanoTime()
        try { transport.subscribe(::frame) } catch (_: Exception) { /* Reconcile on reconnect. */ }
        connectionChanged(false)
        if (closed.get()) return
        val stable = System.nanoTime() - started > TimeUnit.SECONDS.toNanos(30)
        retrySeconds = if (stable) 2 else (retrySeconds * 2).coerceAtMost(60)
        runCatching { stream.schedule(::listen, retrySeconds, TimeUnit.SECONDS) }
    }

    private fun frame(frame: SseFrame) {
        when (frame.event) {
            "connected" -> connectionChanged(true)
            "message" -> changed(frame.data)
            "serialized-error", "return" -> throw IOException("Subscription ended")
        }
    }

    private fun changed(data: String) {
        val event = JSONObject(data).getString("type")
        if (event !in CortexTransport.EVENTS && event != "ui-subscribe.dropped") return
        apply { revision.incrementAndGet(); refreshSoon() }
    }

    private fun connectionChanged(value: Boolean) {
        apply {
            connected = value
            revision.incrementAndGet()
            if (value) refreshSoon() else presenter.updateSummary(null)
        }
    }

    private fun refresh() {
        if (closed.get()) return
        val version = revision.get()
        refreshSessions(version)
        refreshApprovals()
    }

    private fun refreshSessions(version: Long) {
        try {
            val sessions = Protocol.sessions(transport.query("sessions.list", JSONObject().put("origin", "direct")).toString())
            val awaiting = sessions.filter { it.awaiting }
            applySnapshot(version) {
                presenter.updateSummary(if (connected) sessions.count { it.running } else null)
                presenter.removeInactiveSessions(awaiting.map { it.id }.toSet())
            }
            for (session in awaiting) {
                if (closed.get() || version != revision.get()) return
                val alerts = pending(session) ?: continue
                applySnapshot(version) { presenter.reconcile("session:${session.id}", alerts) }
            }
        } catch (_: Exception) {
            applySnapshot(version) {
                transport.interruptSubscription()
                presenter.updateSummary(null)
            }
        }
    }

    private fun applySnapshot(version: Long, block: () -> Unit) {
        apply {
            if (version != revision.get()) { refreshSoon(); return@apply }
            block()
        }
    }

    private fun pending(session: Session): List<Alert>? {
        // This existing endpoint uses web:<sessionId>, unlike sessions.list which
        // checks the session's actual channel. Non-web direct sessions can report
        // awaitingInput without retrievable details. Do not invent request IDs.
        // One request at a time bounds concurrency; no transcripts are fetched.
        return runCatching {
            val body = transport.query("sessions.pendingInteraction", JSONObject().put("sessionId", session.id))
            Protocol.interactions(session, body as JSONObject)
        }.getOrNull()
    }

    private fun refreshApprovals() {
        runCatching {
            val alerts = Protocol.approvals(transport.query("approvals.list", JSONObject().put("status", "pending")).toString())
            apply { presenter.reconcile("approvals", alerts) }
        }
    }

    private fun apply(block: () -> Unit) {
        synchronized(state) {
            if (closed.get() || !state.accepts(lease)) return
            if (!presenter.canRun()) { permissionLost(); return }
            runCatching(block)
        }
    }

    fun close() {
        closed.set(true)
        transport.close()
        snapshots.shutdownNow()
        stream.shutdownNow()
    }
}
