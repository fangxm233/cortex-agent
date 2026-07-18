package dev.cortex.download

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class DownloadArgs {
    lateinit var url: String
    lateinit var fileName: String
    var token: String? = null
    var mimeType: String? = null
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
}
