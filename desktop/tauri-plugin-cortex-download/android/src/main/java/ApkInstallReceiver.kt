package dev.cortex.download

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Status callback for the self-update install session (see ApkInstaller). Declared in the manifest
// rather than registered at runtime because the interesting statuses arrive precisely when this
// process is being replaced or has already been killed: a manifest receiver lets the system start
// us again just to deliver the result. exported="false" + an explicit PendingIntent component keep
// it addressable only by the package installer we handed the IntentSender to.
class ApkInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_STATUS) return
        ApkInstaller.onStatus(context.applicationContext, intent)
    }

    companion object {
        const val ACTION_STATUS = "dev.cortex.download.APK_INSTALL_STATUS"
    }
}
