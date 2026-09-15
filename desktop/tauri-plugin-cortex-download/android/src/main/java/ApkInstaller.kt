package dev.cortex.download

import android.app.Activity
import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File

// App-shell self-update on Android: stream the downloaded, sha256-verified APK into a
// PackageInstaller session while the user is busy, then commit it the moment the app leaves the
// screen.
//
// WHY A SESSION AND NOT `ACTION_VIEW`: the ACTION_VIEW intent hands the APK to the system package
// installer, which ALWAYS shows its confirm screen. A session committed with
// `setRequireUserAction(USER_ACTION_NOT_REQUIRED)` skips that screen — but only when EVERY one of
// these holds (see PackageInstaller.SessionParams#setRequireUserAction):
//   1. we hold REQUEST_INSTALL_PACKAGES *and* declare UPDATE_PACKAGES_WITHOUT_USER_ACTION — both
//      live in this plugin's manifest; the second is a normal permission, granted at install time.
//      It only counts once the *running* build declares it, so the release that introduces this
//      code is still installed the old way, and the one after it is the first silent one;
//   2. the installer is the update owner / installer of record of the package — or, our case, is
//      updating ITSELF. A copy the user sideloaded by hand has some other installer of record, so
//      whether the very first self-update is silent depends on how that build got onto the device;
//   3. the app being installed targets at least API 29 on Android 12, API 30 on Android 13, API 31
//      on Android 14, API 33 on Android 15, API 34 on Android 16 — the floor tracks Play's target
//      policy and keeps rising, which is exactly why the pending-user-action path below is not
//      optional. Our targetSdk comes from `tauri android init` (gen/android is generated, not
//      committed), so it is not pinned in this repository.
// Below API 31 `setRequireUserAction` does not exist at all: every install is confirmed, so those
// devices go straight down the old ACTION_VIEW path.
//
// WHY `installApk` DOES NOT COMMIT: committing replaces this very package and the system kills the
// process to do it. Under the user's fingers that is indistinguishable from a crash. So the Rust
// call only writes the bytes ("staging") and arms a watcher; the commit happens on the first
// transition to the background — the closest thing Android has to the desktop's quit-time install.
internal object ApkInstaller {
    private const val TAG = "CortexApkInstall"
    private const val PREFS = "cortex-apk-install"
    private const val KEY_SESSION = "session"
    private const val KEY_COMMITTED = "committed"
    private const val KEY_VERSION = "staged-version"
    private const val KEY_ERROR = "last-error"
    private const val KEY_FAILURES = "failures"
    private const val KEY_PENDING_KIND = "pending-kind"
    private const val KEY_PENDING_DATA = "pending-data"
    private const val KEY_PENDING_SESSION = "pending-session"
    private const val PENDING_CONFIRM = "confirm"
    private const val PENDING_VIEW = "view"
    private const val APK_ENTRY = "base.apk"
    private const val APK_MIME = "application/vnd.android.package-archive"

    // Two refused sessions in a row and we stop being clever: the next attempt goes straight to the
    // system installer UI. A site that cannot commit silently must not retry quietly forever.
    private const val MAX_SESSION_FAILURES = 2

    /** The APK is written and the commit is armed; nothing is shown to the user. */
    const val MODE_STAGED = "staged"

    /** The system package installer was raised (or parked for the next foreground moment). */
    const val MODE_PROMPT = "prompt"

    private val lock = Any()
    private var watching: Application? = null
    private var startedActivities = 0
    private var everStarted = false
    private var resumed: Activity? = null
    private var committing = false

    /**
     * Start watching the process lifecycle. Called from the plugin's `load`, so the counters below
     * are armed from the first activity start of the process onwards.
     *
     * `ProcessLifecycleOwner` would say the same thing in fewer lines, but it lives in
     * `androidx.lifecycle:lifecycle-process`, which is on neither this module's nor the generated
     * app module's classpath (appcompat only brings `lifecycle-runtime`). Counting started
     * activities with the framework's own `ActivityLifecycleCallbacks` costs no new dependency.
     */
    fun attach(activity: Activity) {
        val application = activity.application ?: return
        synchronized(lock) {
            if (watching != null) return
            watching = application
        }
        application.registerActivityLifecycleCallbacks(callbacks)
    }

    /**
     * Stage [apk] and arm the commit. Returns [MODE_STAGED] or [MODE_PROMPT]; throws when the
     * update could not be handed over at all, which is what the Rust side counts as a failed
     * attempt.
     *
     * Runs on a worker thread (it copies the whole APK) — see DownloadPlugin.installApk.
     */
    fun install(activity: Activity, apk: File): String {
        val context = activity.applicationContext
        attach(activity)
        forgetIfLanded(context)
        // A commit happens minutes or hours after the Rust call that staged it, so its failure has
        // no caller left to report to. Park it and answer the NEXT call with it: that call does no
        // work, but it is the only seam through which `update_prefs.failed_attempts` can learn
        // that silent updating is not working on this device.
        consumeError(context)?.let { throw IllegalStateException(it) }
        val failures = prefs(context).getInt(KEY_FAILURES, 0)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || failures >= MAX_SESSION_FAILURES) {
            Log.i(TAG, "handing ${apk.name} to the system installer (api=${Build.VERSION.SDK_INT}, failures=$failures)")
            promptSystemInstaller(activity, apk)
            return MODE_PROMPT
        }
        return try {
            stage(context, apk)
            // The check thread may well have run while the app was already in the background: that
            // is the safest moment there is, so do not make the user open and leave the app again.
            if (isBackground()) commitStaged(context)
            MODE_STAGED
        } catch (e: Exception) {
            // Staging is the part that can still fail with the user present (no space, no installer
            // service, session quota). Degrading now beats waiting a whole check cycle.
            Log.w(TAG, "could not stage ${apk.name}; falling back to the system installer", e)
            promptSystemInstaller(activity, apk)
            MODE_PROMPT
        }
    }

    /**
     * Session status callback, delivered to [ApkInstallReceiver]. May arrive in a process that was
     * restarted purely to receive it — nothing here may assume an activity exists.
     */
    fun onStatus(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        val session = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        when (status) {
            // The graceful degradation: one of the conditions in this file's header did not hold,
            // so the system hands back the very confirm screen ACTION_VIEW used to raise. Show it.
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = confirmIntent(intent)
                if (confirm == null) {
                    fail(context, "the package installer asked for user action without an intent")
                    return
                }
                Log.i(TAG, "session $session needs user confirmation — raising it at the next foreground moment")
                prompt(context, PENDING_CONFIRM, confirm.toUri(Intent.URI_INTENT_SCHEME), session) {
                    confirm
                }
            }
            // Rarely seen: a successful update kills this process before the broadcast lands. The
            // reliable success signal is `forgetIfLanded`, below.
            PackageInstaller.STATUS_SUCCESS -> {
                Log.i(TAG, "session $session installed")
                forget(context)
                prefs(context).edit().putInt(KEY_FAILURES, 0).remove(KEY_VERSION).apply()
            }
            // STATUS_FAILURE_ABORTED lands here too — that is the user declining the confirm screen
            // above, which is a perfectly good reason to stop updating silently.
            else -> {
                fail(context, "the package installer refused the update (status $status" +
                    (message?.let { ": $it" } ?: "") + ")")
                forget(context)
            }
        }
    }

    // ---- staging / committing ---------------------------------------------------------------

    private fun stage(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        // Each staged session holds a second copy of the APK. Drop the previous one first, or a few
        // update cycles would sit on a few hundred megabytes of the data partition.
        abandonStaged(context)
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        params.setSize(apk.length())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // API 31+ only, and only a request: the system silently downgrades it to a
            // STATUS_PENDING_USER_ACTION callback whenever the conditions in the header fail.
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val session = installer.createSession(params)
        try {
            installer.openSession(session).use { open ->
                open.openWrite(APK_ENTRY, 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out) }
                    open.fsync(out) // Must happen before close, or the session keeps a short write.
                }
            }
        } catch (e: Exception) {
            runCatching { installer.abandonSession(session) }
            throw e
        }
        prefs(context).edit()
            .putInt(KEY_SESSION, session)
            .putBoolean(KEY_COMMITTED, false)
            .putString(KEY_VERSION, archiveVersion(context, apk))
            .apply()
        Log.i(
            TAG,
            "staged ${apk.name} as session $session (installer of record: ${installerOfRecord(context)})",
        )
    }

    private fun commitStaged(context: Context) {
        val session = synchronized(lock) {
            if (committing) return
            val stored = prefs(context).getInt(KEY_SESSION, -1)
            if (stored < 0 || prefs(context).getBoolean(KEY_COMMITTED, false)) return
            committing = true
            stored
        }
        // Off the main thread: commit talks to the package manager over binder, and this runs from
        // an Activity.onStop callback.
        Thread {
            val installer = context.packageManager.packageInstaller
            try {
                if (installer.getSessionInfo(session) == null) {
                    // Expired or abandoned behind our back; next check re-stages.
                    Log.w(TAG, "staged session $session is gone")
                    forget(context)
                    return@Thread
                }
                prefs(context).edit().putBoolean(KEY_COMMITTED, true).apply()
                installer.openSession(session).use { it.commit(statusSender(context, session)) }
                Log.i(TAG, "committed session $session from the background")
            } catch (e: Exception) {
                fail(context, "committing the install session failed: ${e.message}")
                runCatching { installer.abandonSession(session) }
                forget(context)
            } finally {
                synchronized(lock) { committing = false }
            }
        }.start()
    }

    /**
     * The status callback has to survive our process being killed mid-install, so it targets a
     * manifest-declared receiver (a runtime-registered one would die with the process). The system
     * fills the broadcast in with its extras, which is why the PendingIntent must be MUTABLE.
     */
    private fun statusSender(context: Context, session: Int): android.content.IntentSender {
        val intent = Intent(context, ApkInstallReceiver::class.java)
            .setAction(ApkInstallReceiver.ACTION_STATUS)
            .putExtra(PackageInstaller.EXTRA_SESSION_ID, session)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
        return PendingIntent.getBroadcast(context, session, intent, flags).intentSender
    }

    private fun abandonStaged(context: Context) {
        val session = prefs(context).getInt(KEY_SESSION, -1)
        if (session >= 0) {
            runCatching { context.packageManager.packageInstaller.abandonSession(session) }
        }
        forget(context)
    }

    // ---- the old, confirmed path ---------------------------------------------------------------

    /**
     * What this plugin did before sessions existed: hand the APK to the system package installer
     * through the plugin's FileProvider. Still the fallback for API < 31, for a session that could
     * not be staged, and for a device that keeps refusing silent commits.
     */
    private fun promptSystemInstaller(activity: Activity, apk: File) {
        prompt(activity.applicationContext, PENDING_VIEW, apk.absolutePath, -1) {
            viewIntent(activity, apk)
        }
    }

    private fun viewIntent(context: Context, apk: File): Intent {
        val uri = FileProvider.getUriForFile(
            context, "${context.packageName}.cortex.fileprovider", apk,
        )
        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, APK_MIME)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    /**
     * Show [build]'s intent now if the app is on screen, otherwise park it until it is. From API 29
     * on, an activity started from the background is dropped on the floor without an error — and
     * the shell installs updates from a timer, so "nobody is looking" is the normal case.
     */
    private fun prompt(context: Context, kind: String, data: String, session: Int, build: () -> Intent) {
        val activity = synchronized(lock) { resumed }
        if (activity != null) {
            // Raised from the staging worker as often as from the main thread, so hop over: the
            // platform tolerates a background startActivity call, the rest of the app does not.
            activity.runOnUiThread {
                runCatching { activity.startActivity(build()) }
                    .onFailure { Log.w(TAG, "could not raise the installer", it) }
            }
            return
        }
        prefs(context).edit()
            .putString(KEY_PENDING_KIND, kind)
            .putString(KEY_PENDING_DATA, data)
            .putInt(KEY_PENDING_SESSION, session)
            .apply()
    }

    private fun drainPrompt(activity: Activity) {
        val prefs = prefs(activity.applicationContext)
        val kind = prefs.getString(KEY_PENDING_KIND, null) ?: return
        val data = prefs.getString(KEY_PENDING_DATA, null)
        val session = prefs.getInt(KEY_PENDING_SESSION, -1)
        prefs.edit().remove(KEY_PENDING_KIND).remove(KEY_PENDING_DATA).remove(KEY_PENDING_SESSION).apply()
        if (data == null) return
        // A parked confirmation only means something while its session is alive; sessions expire,
        // and a later check may have abandoned this one. Raising a dead one shows a bare error.
        if (session >= 0 &&
            activity.packageManager.packageInstaller.getSessionInfo(session) == null
        ) {
            return
        }
        runCatching {
            val intent = when (kind) {
                PENDING_CONFIRM -> Intent.parseUri(data, Intent.URI_INTENT_SCHEME)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                // Rebuilt rather than serialized: `Intent.parseUri` strips FLAG_GRANT_READ_URI_
                // PERMISSION, which is the only reason the installer can read our private APK.
                PENDING_VIEW -> File(data).takeIf { it.isFile }?.let { viewIntent(activity, it) } ?: return
                else -> return
            }
            activity.startActivity(intent)
        }.onFailure { Log.w(TAG, "could not raise the parked installer", it) }
    }

    // ---- bookkeeping ---------------------------------------------------------------------------

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun fail(context: Context, reason: String) {
        Log.w(TAG, reason)
        val prefs = prefs(context)
        prefs.edit()
            .putString(KEY_ERROR, reason)
            .putInt(KEY_FAILURES, prefs.getInt(KEY_FAILURES, 0) + 1)
            .apply()
    }

    private fun consumeError(context: Context): String? {
        val error = prefs(context).getString(KEY_ERROR, null) ?: return null
        prefs(context).edit().remove(KEY_ERROR).apply()
        return error
    }

    private fun forget(context: Context) {
        prefs(context).edit().remove(KEY_SESSION).remove(KEY_COMMITTED).apply()
    }

    /**
     * A committed self-update kills this process, so STATUS_SUCCESS usually never arrives. The
     * evidence that it worked is that we are now running the version we staged — which is also the
     * only thing that clears the failure counter, so a run of unrelated hiccups cannot strand the
     * app on the confirmed path forever.
     */
    private fun forgetIfLanded(context: Context) {
        val staged = prefs(context).getString(KEY_VERSION, null) ?: return
        if (staged != runningVersion(context)) return
        Log.i(TAG, "staged version $staged is the running version — a silent update landed")
        prefs(context).edit()
            .remove(KEY_VERSION)
            .remove(KEY_SESSION)
            .remove(KEY_COMMITTED)
            .remove(KEY_ERROR)
            .putInt(KEY_FAILURES, 0)
            .apply()
    }

    private fun archiveVersion(context: Context, apk: File): String? =
        runCatching { context.packageManager.getPackageArchiveInfo(apk.absolutePath, 0)?.versionName }
            .getOrNull()

    private fun runningVersion(context: Context): String? =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }
            .getOrNull()

    private fun installerOfRecord(context: Context): String? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            context.packageManager.getInstallerPackageName(context.packageName)
        }
    }.getOrNull()

    private fun confirmIntent(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        }

    // `everStarted` guards the count: before the first activity start the counter is 0 for the
    // trivial reason that nothing has happened yet, which is not the same as "the user left".
    private fun isBackground(): Boolean = synchronized(lock) { everStarted && startedActivities == 0 }

    private val callbacks = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

        override fun onActivityStarted(activity: Activity) {
            synchronized(lock) {
                startedActivities += 1
                everStarted = true
            }
        }

        override fun onActivityResumed(activity: Activity) {
            synchronized(lock) { resumed = activity }
            drainPrompt(activity)
        }

        override fun onActivityPaused(activity: Activity) {
            synchronized(lock) { if (resumed === activity) resumed = null }
        }

        override fun onActivityStopped(activity: Activity) {
            val background = synchronized(lock) {
                startedActivities = (startedActivities - 1).coerceAtLeast(0)
                // A rotation stops and restarts the activity without the app ever leaving the
                // screen. ProcessLifecycleOwner debounces that with a 700ms timer; this flag is the
                // dependency-free equivalent.
                startedActivities == 0 && !activity.isChangingConfigurations
            }
            if (background) commitStaged(activity.applicationContext)
        }

        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

        override fun onActivityDestroyed(activity: Activity) {}
    }
}
