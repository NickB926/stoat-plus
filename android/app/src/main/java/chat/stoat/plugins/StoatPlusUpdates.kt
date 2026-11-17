package chat.stoat.plugins

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import chat.stoat.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

data class StoatPlusRelease(
    val version: String,
    val notes: String,
    val apkUrl: String,
    val pageUrl: String,
)

sealed interface UpdateState {
    data object Idle : UpdateState
    data class Available(val release: StoatPlusRelease) : UpdateState
    data class Downloading(val release: StoatPlusRelease, val progress: Float) : UpdateState
}

/**
 * Stoat+ self-updates: checks the latest GitHub release of [BuildConfig.STOATPLUS_REPO]
 * and installs its APK. Releases are signed with the same key, so they install
 * over the current version and keep the login and plugins.
 */
object StoatPlusUpdates {
    private const val TAG = "StoatPlusUpdates"
    private const val CHECK_EVERY_MS = 6 * 60 * 60 * 1000L

    val currentVersion: String get() = BuildConfig.STOATPLUS_VERSION
    val releasesPage: String get() = "https://github.com/${BuildConfig.STOATPLUS_REPO}/releases"

    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state

    private fun prefs(context: Context) =
        context.getSharedPreferences("stoat_plus_updates", Context.MODE_PRIVATE)

    /** Newer than ours? Compares dotted numbers: 1.10.0 > 1.9.3. */
    fun isNewer(candidate: String, current: String = currentVersion): Boolean {
        fun parts(v: String) = v.removePrefix("v").split(".", "-", "+")
            .take(3).map { it.toIntOrNull() ?: 0 }.plus(listOf(0, 0, 0)).take(3)
        val a = parts(candidate)
        val b = parts(current)
        for (i in 0 until 3) if (a[i] != b[i]) return a[i] > b[i]
        return false
    }

    private suspend fun fetchLatest(): StoatPlusRelease? = withContext(Dispatchers.IO) {
        val conn = URL("https://api.github.com/repos/${BuildConfig.STOATPLUS_REPO}/releases/latest")
            .openConnection() as HttpURLConnection
        conn.setRequestProperty("Accept", "application/vnd.github+json")
        conn.connectTimeout = 15_000
        conn.readTimeout = 15_000
        try {
            if (conn.responseCode == 404) return@withContext null // no releases yet
            if (conn.responseCode !in 200..299) error("GitHub said HTTP ${conn.responseCode}")
            val release = Json.parseToJsonElement(conn.inputStream.bufferedReader().use { it.readText() })
                .jsonObject
            val apk = release["assets"]?.jsonArray?.firstOrNull {
                it.jsonObject["name"]?.jsonPrimitive?.contentOrNull?.endsWith(".apk") == true
            }?.jsonObject ?: return@withContext null
            StoatPlusRelease(
                version = release["tag_name"]?.jsonPrimitive?.contentOrNull?.removePrefix("v") ?: return@withContext null,
                notes = release["body"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                apkUrl = apk["browser_download_url"]?.jsonPrimitive?.contentOrNull ?: return@withContext null,
                pageUrl = release["html_url"]?.jsonPrimitive?.contentOrNull ?: releasesPage,
            )
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Look for an update. Automatic checks run at most every few hours and
     * respect "skip this version"; manual checks always run and report back.
     */
    suspend fun check(context: Context, manual: Boolean) {
        val prefs = prefs(context)
        val now = System.currentTimeMillis()
        if (!manual && now - prefs.getLong("lastCheck", 0) < CHECK_EVERY_MS) return
        prefs.edit().putLong("lastCheck", now).apply()

        val release = try {
            fetchLatest()
        } catch (e: Exception) {
            Log.w(TAG, "Update check failed", e)
            if (manual) toast(context, "Couldn't check for updates: ${e.message}")
            return
        }

        when {
            release == null || !isNewer(release.version) ->
                if (manual) toast(context, "Stoat+ $currentVersion is the latest version")

            !manual && prefs.getString("skipped", null) == release.version -> Unit
            else -> _state.value = UpdateState.Available(release)
        }
    }

    fun dismiss(context: Context, skip: Boolean) {
        val current = _state.value
        if (skip && current is UpdateState.Available) {
            prefs(context).edit().putString("skipped", current.release.version).apply()
        }
        _state.value = UpdateState.Idle
    }

    suspend fun downloadAndInstall(context: Context, release: StoatPlusRelease) {
        val app = context.applicationContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !app.packageManager.canRequestPackageInstalls()) {
            toast(app, "Allow Stoat+ to install updates, then tap Update again")
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${app.packageName}".toUri())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            return
        }

        _state.value = UpdateState.Downloading(release, 0f)
        val file = try {
            download(app, release) { p -> _state.value = UpdateState.Downloading(release, p) }
        } catch (e: Exception) {
            Log.w(TAG, "Update download failed", e)
            toast(app, "Download failed: ${e.message}")
            _state.value = UpdateState.Available(release)
            return
        }
        _state.value = UpdateState.Idle

        val uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", file)
        context.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    private suspend fun download(
        context: Context,
        release: StoatPlusRelease,
        onProgress: (Float) -> Unit,
    ): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val target = File(dir, "stoat-plus-${release.version}.apk")
        val conn = URL(release.apkUrl).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 30_000
        try {
            if (conn.responseCode !in 200..299) error("HTTP ${conn.responseCode}")
            val total = conn.contentLengthLong.takeIf { it > 0 }
            conn.inputStream.use { input ->
                target.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var lastReport = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        done += n
                        if (total != null && done - lastReport > 256 * 1024) {
                            lastReport = done
                            val p = done.toFloat() / total
                            withContext(Dispatchers.Main) { onProgress(p) }
                        }
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
        target
    }

    private suspend fun toast(context: Context, text: String) = withContext(Dispatchers.Main) {
        Toast.makeText(context.applicationContext, text, Toast.LENGTH_LONG).show()
    }
}

/** Checks for updates on launch and shows the update dialog. Put once near the app root. */
@Composable
fun StoatPlusUpdatePrompt() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val state by StoatPlusUpdates.state.collectAsState()

    LaunchedEffect(Unit) { StoatPlusUpdates.check(context, manual = false) }

    when (val s = state) {
        UpdateState.Idle -> Unit
        is UpdateState.Available -> AlertDialog(
            onDismissRequest = { StoatPlusUpdates.dismiss(context, skip = false) },
            title = { Text("Stoat+ ${s.release.version} is available") },
            text = {
                Column(
                    Modifier
                        .heightIn(max = 320.dp)
                        .verticalScroll(rememberScrollState())
                ) {
                    Text(
                        "You have ${StoatPlusUpdates.currentVersion}. Updating keeps your login and plugins.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (s.release.notes.isNotBlank()) {
                        Spacer(Modifier.height(12.dp))
                        Text(s.release.notes.take(1500), style = MaterialTheme.typography.bodySmall)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { StoatPlusUpdates.downloadAndInstall(context, s.release) }
                }) { Text("Update") }
            },
            dismissButton = {
                Column {
                    TextButton(onClick = { StoatPlusUpdates.dismiss(context, skip = false) }) { Text("Later") }
                    TextButton(onClick = { StoatPlusUpdates.dismiss(context, skip = true) }) {
                        Text("Skip this version")
                    }
                }
            },
        )

        is UpdateState.Downloading -> AlertDialog(
            onDismissRequest = {},
            title = { Text("Downloading Stoat+ ${s.release.version}") },
            text = {
                LinearProgressIndicator(
                    progress = { s.progress },
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {},
        )
    }
}
