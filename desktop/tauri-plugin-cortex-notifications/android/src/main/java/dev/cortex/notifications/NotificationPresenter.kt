// input:  Android notifications, scoped durable target ledger
// output: Private service, interaction, reply and completion notifications
// pos:    Sole Android notification presentation owner
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.util.UUID

internal class NotificationPresenter(private val context: Context, private val state: NotificationState) {
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val text get() = NotificationText(state.connection.locale)

    fun permissionGranted(): Boolean {
        val runtime = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(
            context, Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        return runtime && NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    fun channels() {
        if (Build.VERSION.SDK_INT < 26) return
        val service = NotificationChannel(SERVICE_CHANNEL, text.background, NotificationManager.IMPORTANCE_LOW)
        service.setSound(null, null)
        service.enableVibration(false)
        val alerts = NotificationChannel(ALERT_CHANNEL, text.attention, NotificationManager.IMPORTANCE_DEFAULT)
        val replies = NotificationChannel(REPLY_CHANNEL, text.replies, NotificationManager.IMPORTANCE_DEFAULT)
        listOf(service, alerts, replies).forEach {
            it.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            manager.createNotificationChannel(it)
        }
    }

    fun canRun(): Boolean = permissionGranted() && channelAllowed(SERVICE_CHANNEL)

    private fun channelAllowed(channel: String): Boolean = Build.VERSION.SDK_INT < 26 ||
        manager.getNotificationChannel(channel)?.importance != NotificationManager.IMPORTANCE_NONE

    fun summary(count: Int?): Notification {
        val route = state.ledger.issued.values.firstOrNull { it.summary }
            ?: issue(Action(state.connection.scope, "sessions"), SUMMARY_TAG, true)
        return base(SERVICE_CHANNEL, text.background, text.summary(count), route)
            .setOngoing(true).setAutoCancel(false).setSilent(true)
            .setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_SERVICE).build()
    }

    fun updateSummary(count: Int?) {
        manager.notify(SERVICE_ID, summary(count))
    }

    fun post(title: String, body: String, sessionId: String?, projectId: String?) {
        check(permissionGranted() && channelAllowed(REPLY_CHANNEL))
        check(state.connection.scope.isNotEmpty())
        val action = Action(state.connection.scope, if (sessionId == null) "sessions" else "session", sessionId, projectId)
        val route = issue(action, "$PREFIX.reply.${UUID.randomUUID()}", false)
        notify(route, REPLY_CHANNEL, title.take(80), body.take(180))
    }

    fun reconcile(owner: String, alerts: List<Alert>) {
        val changes = AlertChanges.between(state.ledger.seen, owner, alerts)
        if (changes.resolved.isEmpty() && changes.added.isEmpty()) return
        changes.resolved.forEach(::removeAlert)
        if (!permissionGranted() || !channelAllowed(ALERT_CHANNEL)) { state.save(); return }
        changes.added.forEach(::postAlert)
        state.save()
    }

    fun completions(scan: CompletionScan, visible: String?) {
        scan.announce.filter { it.sessionId != visible }.forEach(::postCompletion)
        state.ledger.remember(scan.processed)
        state.save()
    }

    // One stable tag per session: a newer turn or a retry after a failed post replaces the
    // notification instead of stacking, so the ledger holds a single route per session.
    private fun postCompletion(completion: Completion) {
        if (!permissionGranted() || !channelAllowed(REPLY_CHANNEL)) return
        val tag = "$PREFIX.completion.${digest(completion.sessionId)}"
        state.ledger.issued.values.filter { it.tag == tag }.toList()
            .forEach { state.ledger.issued.remove(it.action.actionId) }
        val action = Action(state.connection.scope, "session", completion.sessionId, completion.projectId)
        notify(issue(action, tag, false), REPLY_CHANNEL, text.session(completion.name).take(80), text.completion)
    }

    fun removeInactiveSessions(awaitingIds: Set<String>) {
        state.ledger.seen.values.map { it.owner }.distinct()
            .filter { it.startsWith("session:") && it.removePrefix("session:") !in awaitingIds }
            .forEach { reconcile(it, emptyList()) }
    }

    private fun postAlert(alert: Alert) {
        val action = Action(state.connection.scope, if (alert.kind == "approval") "approvals" else "session",
            alert.sessionId, alert.projectId, alert.approvalId)
        val route = issue(action, "$PREFIX.alert.${alert.key}", false)
        state.ledger.seen[alert.key] = SeenAlert(alert.owner, action.actionId)
        state.save()
        try {
            notify(route, ALERT_CHANNEL, text.attention, text.alert(alert.kind))
        } catch (error: Exception) {
            state.ledger.seen.remove(alert.key)
            state.save()
            throw error
        }
    }

    private fun removeAlert(key: String) {
        val seen = state.ledger.seen.remove(key) ?: return
        manager.cancel("$PREFIX.alert.$key", ALERT_ID)
        state.ledger.issued.remove(seen.routeId)
    }

    fun clear() {
        manager.activeNotifications.filter { it.tag?.startsWith(PREFIX) == true }
            .forEach { manager.cancel(it.tag, it.id) }
        manager.cancel(SERVICE_ID)
        state.ledger.clear()
        state.save()
    }

    fun cancelTapped(route: Issued) {
        if (!route.summary) manager.cancel(route.tag, ALERT_ID)
    }

    private fun issue(action: Action, tag: String, summary: Boolean): Issued {
        val route = Issued(action, tag, summary)
        state.ledger.issued[action.actionId] = route
        state.save() // Persist before exposing the PendingIntent to Android.
        return route
    }

    private fun notify(route: Issued, channel: String, title: String, body: String) {
        try {
            manager.notify(route.tag, ALERT_ID, base(channel, title, body, route).setAutoCancel(true).build())
        } catch (error: Exception) {
            state.ledger.issued.remove(route.action.actionId)
            state.save()
            throw error
        }
    }

    private fun base(channel: String, title: String, body: String, route: Issued): NotificationCompat.Builder {
        val public = NotificationCompat.Builder(context, channel).setSmallIcon(icon())
            .setContentTitle("Cortex").setContentText(text.privateContent).build()
        return NotificationCompat.Builder(context, channel).setSmallIcon(icon())
            .setContentTitle(title).setContentText(body).setContentIntent(pendingIntent(route))
            .setDeleteIntent(if (route.summary) null else dismissIntent(route))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(public)
            .setOnlyAlertOnce(true)
    }

    private fun pendingIntent(route: Issued): PendingIntent {
        val intent = requireNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName))
        intent.action = "$PREFIX.${route.action.actionId}"
        intent.data = Uri.parse("cortex-notification://action/${route.action.actionId}")
        intent.setPackage(context.packageName)
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun dismissIntent(route: Issued): PendingIntent {
        val intent = Intent(context, NotificationDismissReceiver::class.java)
            .setAction("$PREFIX.dismiss.${route.action.actionId}")
            .setData(Uri.parse("cortex-notification://dismiss/${route.action.actionId}"))
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun icon(): Int = R.drawable.ic_cortex_notification

    companion object {
        const val PREFIX = "dev.cortex.notifications"
        const val SERVICE_ID = 1842101
        const val ALERT_ID = 1842102
        const val SUMMARY_TAG = "$PREFIX.summary"
        const val SERVICE_CHANNEL = "$PREFIX.connection.v1"
        const val ALERT_CHANNEL = "$PREFIX.attention.v1"
        const val REPLY_CHANNEL = "$PREFIX.replies.v1"
    }
}
