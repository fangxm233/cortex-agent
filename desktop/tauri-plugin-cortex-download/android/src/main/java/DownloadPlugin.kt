package dev.cortex.download

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import androidx.core.content.FileProvider
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

    // Raises the system package installer over a downloaded, sha256-verified APK (app shell
    // self-update). The APK sits in the app-private data dir, so it is exposed to the installer
    // through this plugin's FileProvider (manifest-declared, ${applicationId}.cortex.fileprovider);
    // REQUEST_INSTALL_PACKAGES lets the install-unknown-apps consent flow run. Called from Rust via
    // run_mobile_plugin only — never from the webview.
    @Command
    fun installApk(invoke: Invoke) {
        val args = invoke.parseArgs(InstallApkArgs::class.java)
        try {
            val file = File(args.path)
            if (!file.exists()) {
                invoke.reject("apk not found: ${args.path}")
                return
            }
            val uri = FileProvider.getUriForFile(
                activity, "${activity.packageName}.cortex.fileprovider", file,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "apk install failed")
        }
    }
}
