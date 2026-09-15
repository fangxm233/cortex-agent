package dev.cortex.download

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class DownloadArgs {
    lateinit var url: String
    lateinit var fileName: String
    var token: String? = null
    var mimeType: String? = null
}

@InvokeArg
class InstallApkArgs {
    lateinit var path: String
}

// Saves a file to the PUBLIC Downloads folder using the system DownloadManager. DownloadManager
// downloads the URL directly into the Downloads collection (exempt from scoped-storage limits),
// registers it with MediaStore (so it appears in Files / Downloads), and shows the native
// download-progress + "download complete" notification — the feedback the user asked for.
@TauriPlugin
class DownloadPlugin(private val activity: Activity) : Plugin(activity) {
    // Arm the self-update watcher for the whole process, not just for the window in which an update
    // is staged: a confirmation parked by an earlier run has to be raised the next time the user
    // opens the app, and that can be a later process entirely (see ApkInstaller).
    override fun load(webView: WebView) {
        ApkInstaller.attach(activity)
    }

    @Command
    fun download(invoke: Invoke) {
        val args = invoke.parseArgs(DownloadArgs::class.java)
        try {
            val request = DownloadManager.Request(Uri.parse(args.url))
                .setTitle(args.fileName)
                .setDescription(args.fileName)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, args.fileName)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(true)
            args.token?.let { request.addRequestHeader("x-cortex-token", it) }
            args.mimeType?.let { request.setMimeType(it) }

            val dm = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val id = dm.enqueue(request)

            val ret = JSObject()
            ret.put("id", id)
            invoke.resolve(ret)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "download failed")
        }
    }

    // Takes over a downloaded, sha256-verified APK for the app shell's self-update and answers with
    // the mode it chose: "staged" (written into a PackageInstaller session that commits itself once
    // the app goes to the background) or "prompt" (the system installer, i.e. what this command did
    // before silent updating existed — API < 31, a session that would not stage, or a device that
    // has refused silent commits). Rejecting is the shell's signal to count a failed attempt.
    // Called from Rust via run_mobile_plugin only — never from the webview.
    @Command
    fun installApk(invoke: Invoke) {
        val args = invoke.parseArgs(InstallApkArgs::class.java)
        val file = File(args.path)
        if (!file.isFile) {
            invoke.reject("apk not found: ${args.path}")
            return
        }
        // Staging streams the whole APK (tens of megabytes) into the session, and Tauri runs plugin
        // commands on the UI thread — hence the worker. The answer goes back on the UI thread it
        // came in on, so the Rust caller is never resolved from an unexpected thread.
        Thread {
            val outcome = runCatching { ApkInstaller.install(activity, file) }
            activity.runOnUiThread {
                outcome.fold(
                    onSuccess = { mode -> invoke.resolve(JSObject().also { it.put("mode", mode) }) },
                    onFailure = { e -> invoke.reject(e.message ?: "apk install failed") },
                )
            }
        }.start()
    }
}
