package chat.stoat.plugins

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import chat.stoat.api.StoatAPI
import chat.stoat.api.StoatHttp
import chat.stoat.api.api
import chat.stoat.api.hooks.ClientHooks
import chat.stoat.core.model.schemas.Message
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.content.TextContent
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.isSuccess
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

@Serializable
data class PluginSetting(
    val type: String = "string",
    val label: String? = null,
    val description: String? = null,
    val default: JsonElement? = null,
    val options: List<JsonElement>? = null,
) {
    /** Select options as (value, label) pairs; accepts strings or {value, label}. */
    fun choices(): List<Pair<String, String>> = options.orEmpty().mapNotNull { o ->
        when (o) {
            is JsonPrimitive -> o.contentOrNull?.let { it to it }
            is JsonObject -> {
                val value = o["value"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                value to (o["label"]?.jsonPrimitive?.contentOrNull ?: value)
            }

            else -> null
        }
    }
}

@Serializable
data class PluginInfo(
    val id: String,
    val file: String = "",
    val name: String = id,
    val version: String = "",
    val author: String = "",
    val description: String = "",
    val platforms: List<String> = emptyList(),
    val supported: Boolean = true,
    val enabled: Boolean = false,
    val running: Boolean = false,
    val error: String? = null,
    val settingsSchema: Map<String, PluginSetting> = emptyMap(),
    val settings: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class PluginCommand(val name: String, val description: String = "", val plugin: String = "")

sealed interface SendDecision {
    data class Send(val content: String) : SendDecision
    data object Cancel : SendDecision
}

/**
 * Stoat+ plugin engine. Plugins are JS files in `files/plugins`, run by the
 * shared runtime (assets/stoatplus/runtime.js) inside a hidden WebView, with
 * host-android.js and [Bridge] connecting them to the app.
 */
object PluginEngine {
    private const val TAG = "StoatPlus"
    private const val MAX_PLUGIN_BYTES = 1024 * 1024
    private const val HIDDEN_TEXT = "*(hidden by a plugin)*"

    private lateinit var app: Context
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    private var webView: WebView? = null

    @Volatile
    private var ready = CompletableDeferred<Unit>()
    private val calls = ConcurrentHashMap<Int, CompletableDeferred<Result<String>>>()
    private val nextCallId = AtomicInteger(1)

    @Volatile
    private var sendHooks = 0

    @Volatile
    private var messageHooks = 0

    @Volatile
    private var commandHooks = 0

    private val _plugins = MutableStateFlow<List<PluginInfo>>(emptyList())
    val plugins: StateFlow<List<PluginInfo>> = _plugins

    private val _commands = MutableStateFlow<List<PluginCommand>>(emptyList())
    val commands: StateFlow<List<PluginCommand>> = _commands

    private val prefs by lazy { app.getSharedPreferences("stoat_plus_plugins", Context.MODE_PRIVATE) }
    private val pluginsDir get() = File(app.filesDir, "plugins")

    fun init(context: Context) {
        app = context.applicationContext
        try {
            installExamples()
        } catch (e: Exception) {
            Log.e(TAG, "Couldn't copy example plugins", e)
        }
        ClientHooks.incomingMessages = { messages, live -> filterIncoming(messages, live) }
        scope.launch { startWebView() }
    }

    // ---------- WebView ----------

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun startWebView() {
        webView?.destroy()
        ready = CompletableDeferred()
        val wv = WebView(app)
        wv.settings.javaScriptEnabled = true
        wv.settings.allowFileAccess = false
        wv.settings.allowContentAccess = false
        wv.addJavascriptInterface(Bridge(), "StoatBridge")
        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                val priority = when (message.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> Log.ERROR
                    ConsoleMessage.MessageLevel.WARNING -> Log.WARN
                    else -> Log.INFO
                }
                Log.println(priority, TAG, "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        wv.webViewClient = object : WebViewClient() {
            private var booted = false
            override fun onPageFinished(view: WebView, url: String?) {
                if (booted) return
                booted = true
                scope.launch { boot(view) }
            }
        }
        webView = wv
        wv.loadDataWithBaseURL(
            "https://plugins.stoat-plus.invalid/",
            "<!doctype html><meta charset=\"utf-8\"><title>Stoat+</title>",
            "text/html",
            "utf-8",
            null,
        )
    }

    private suspend fun boot(wv: WebView) {
        try {
            val host = readAsset("stoatplus/host-android.js")
            val runtime = readAsset("stoatplus/runtime.js")
            wv.evaluateJavascript("$host\n;$runtime\n;", null)
            loadAll()
        } catch (e: Exception) {
            Log.e(TAG, "Plugin engine failed to start", e)
        } finally {
            ready.complete(Unit)
        }
    }

    private suspend fun readAsset(path: String): String = withContext(Dispatchers.IO) {
        app.assets.open(path).bufferedReader().use { it.readText() }
    }

    /** Wait for plugins to load, but never hold the app up for long. */
    private suspend fun awaitReady(): Boolean =
        withTimeoutOrNull(4_000) { ready.await() } != null

    /**
     * Evaluate [expression] in the runtime and return its (awaited) result as
     * JSON, or null on error/timeout.
     */
    private suspend fun callJs(expression: String, timeoutMs: Long = 5_000): String? {
        val wv = webView ?: return null
        val id = nextCallId.getAndIncrement()
        val result = CompletableDeferred<Result<String>>()
        calls[id] = result
        return try {
            withContext(Dispatchers.Main) {
                wv.evaluateJavascript("__stoatHostCall($id, () => ($expression));", null)
            }
            val outcome = withTimeoutOrNull(timeoutMs) { result.await() }
            when {
                outcome == null -> {
                    Log.w(TAG, "Plugin call timed out: ${expression.take(80)}")
                    null
                }

                outcome.isFailure -> {
                    Log.e(TAG, "Plugin call failed: ${outcome.exceptionOrNull()?.message}")
                    null
                }

                else -> outcome.getOrNull()
            }
        } finally {
            calls.remove(id)
        }
    }

    private fun jsString(value: String) = JsonPrimitive(value).toString()

    // ---------- hooks used by the app ----------

    /** Run commands and send hooks on a message the user is about to send. */
    suspend fun beforeSend(
        channelId: String,
        content: String,
        replyIds: List<String>,
        hasAttachments: Boolean,
    ): SendDecision {
        if (!this::app.isInitialized) return SendDecision.Send(content)
        if (!awaitReady()) return SendDecision.Send(content)
        if (sendHooks == 0 && commandHooks == 0) return SendDecision.Send(content)

        val arg = buildJsonObject {
            put("channelId", channelId)
            put("content", content)
            put("replyIds", buildJsonArray { replyIds.forEach { add(JsonPrimitive(it)) } })
            put("hasAttachments", hasAttachments)
        }
        val result = callJs("__stoatPlus.runBeforeSend($arg)", 4_000)
            ?.let { runCatching { json.parseToJsonElement(it).jsonObject }.getOrNull() }
            ?: return SendDecision.Send(content)

        return if (result["action"]?.jsonPrimitive?.contentOrNull == "cancel") {
            SendDecision.Cancel
        } else {
            SendDecision.Send(result["content"]?.jsonPrimitive?.contentOrNull ?: content)
        }
    }

    private suspend fun filterIncoming(messages: List<Message>, live: Boolean): List<Message?> {
        if (messageHooks == 0) return messages
        if (!awaitReady() || messageHooks == 0) return messages

        val arg = buildJsonArray {
            messages.forEach { m ->
                add(buildJsonObject {
                    put("id", m.id)
                    put("channelId", m.channel)
                    put("authorId", m.author)
                    put("content", m.content ?: "")
                    put("live", live)
                })
            }
        }
        val results = callJs("__stoatPlus.runMessageHooks($arg)", 4_000)
            ?.let { runCatching { json.parseToJsonElement(it).jsonArray }.getOrNull() }
            ?: return messages
        if (results.size != messages.size) return messages

        return messages.mapIndexed { i, message ->
            val r = results[i]
            when {
                r is JsonNull -> message
                r is JsonPrimitive && r.isString -> message.copy(content = r.content)
                r is JsonPrimitive && r.booleanOrNull == false ->
                    // Live messages disappear; history keeps a placeholder so paging still works.
                    if (live) null
                    else message.copy(content = HIDDEN_TEXT, attachments = null, embeds = null)

                else -> message
            }
        }
    }

    // ---------- management (used by the Plugins screen) ----------

    private fun updateList(listJson: String?) {
        listJson ?: return
        runCatching { json.decodeFromString<List<PluginInfo>>(listJson) }
            .onSuccess { _plugins.value = it }
            .onFailure { Log.e(TAG, "Bad plugin list from runtime", it) }
    }

    private suspend fun refreshCommands() {
        callJs("__stoatPlus.commands()")?.let { text ->
            runCatching { json.decodeFromString<List<PluginCommand>>(text) }
                .onSuccess { _commands.value = it }
        }
    }

    private suspend fun readPluginFiles(): JsonArray = withContext(Dispatchers.IO) {
        pluginsDir.mkdirs()
        buildJsonArray {
            pluginsDir.listFiles { f -> f.isFile && f.name.endsWith(".js", ignoreCase = true) }
                .orEmpty()
                .filter { it.length() <= MAX_PLUGIN_BYTES }
                .sortedBy { it.name.lowercase() }
                .forEach { f ->
                    add(buildJsonObject {
                        put("file", f.name)
                        put("source", f.readText())
                    })
                }
        }
    }

    /** Reload every plugin from disk. */
    suspend fun loadAll() {
        val files = readPluginFiles()
        updateList(callJs("__stoatPlus.loadAll($files)", 15_000))
        refreshCommands()
    }

    suspend fun reload() {
        if (!awaitReady()) return
        loadAll()
    }

    suspend fun setEnabled(id: String, enabled: Boolean) {
        updateList(callJs("__stoatPlus.setEnabled(${jsString(id)}, $enabled)"))
        refreshCommands()
    }

    suspend fun setSetting(id: String, key: String, value: JsonElement) {
        updateList(callJs("__stoatPlus.setSetting(${jsString(id)}, ${jsString(key)}, $value)"))
    }

    suspend fun delete(plugin: PluginInfo) {
        callJs("__stoatPlus.setEnabled(${jsString(plugin.id)}, false)")
        callJs("__stoatPlus.forget(${jsString(plugin.id)})")
        withContext(Dispatchers.IO) { safeFile(plugin.file)?.delete() }
        loadAll()
    }

    /** Save [source] as a plugin and reload. Returns the file name. */
    suspend fun install(source: String, fallbackName: String): Result<String> = runCatching {
        if (source.length > MAX_PLUGIN_BYTES) error("That file is too big for a plugin")
        if (!source.contains("definePlugin")) {
            error("That doesn't look like a Stoat+ plugin (no definePlugin call)")
        }
        val header = Regex("""^\s*/\*\*([\s\S]*?)\*/""").find(source)?.groupValues?.get(1)
        val id = (header?.let { Regex("""@id\s+(\S+)""").find(it)?.groupValues?.get(1) } ?: fallbackName)
            .lowercase()
            .removeSuffix(".js")
            .replace(Regex("[^a-z0-9._-]+"), "-")
            .trim('-', '.')
            .ifEmpty { "plugin" }
        val file = "$id.js"
        withContext(Dispatchers.IO) {
            pluginsDir.mkdirs()
            File(pluginsDir, file).writeText(source)
        }
        loadAll()
        file
    }

    suspend fun installFromUrl(url: String): Result<String> {
        val download = runCatching {
            withContext(Dispatchers.IO) {
                val parsed = URL(url.trim())
                if (parsed.protocol != "https" && parsed.protocol != "http") {
                    error("Only http(s) links can be installed")
                }
                val conn = parsed.openConnection() as HttpURLConnection
                conn.connectTimeout = 15_000
                conn.readTimeout = 15_000
                try {
                    if (conn.responseCode !in 200..299) error("Download failed (HTTP ${conn.responseCode})")
                    val bytes = conn.inputStream.use { it.readNBytesCompat(MAX_PLUGIN_BYTES + 1) }
                    if (bytes.size > MAX_PLUGIN_BYTES) error("That file is too big for a plugin")
                    String(bytes, Charsets.UTF_8) to (parsed.path.substringAfterLast('/').ifEmpty { "plugin" })
                } finally {
                    conn.disconnect()
                }
            }
        }
        val (source, name) = download.getOrElse { return Result.failure(it) }
        return install(source, name)
    }

    suspend fun installFromUri(uri: Uri): Result<String> {
        val read = runCatching {
            withContext(Dispatchers.IO) {
                val bytes = app.contentResolver.openInputStream(uri)?.use { it.readNBytesCompat(MAX_PLUGIN_BYTES + 1) }
                    ?: error("Couldn't open that file")
                if (bytes.size > MAX_PLUGIN_BYTES) error("That file is too big for a plugin")
                String(bytes, Charsets.UTF_8) to (uri.lastPathSegment?.substringAfterLast('/') ?: "plugin")
            }
        }
        val (source, name) = read.getOrElse { return Result.failure(it) }
        return install(source, name)
    }

    private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (out.size() < limit) {
            val n = read(buf, 0, minOf(buf.size, limit - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    private fun safeFile(name: String): File? {
        val base = File(name).name
        if (!Regex("""^[\w.-]+\.js$""", RegexOption.IGNORE_CASE).matches(base)) return null
        return File(pluginsDir, base)
    }

    private fun installExamples() {
        val marker = File(pluginsDir, ".examples-installed")
        if (marker.exists()) return
        pluginsDir.mkdirs()
        app.assets.list("stoatplus/plugins").orEmpty().filter { it.endsWith(".js") }.forEach { name ->
            val target = File(pluginsDir, name)
            if (!target.exists()) {
                app.assets.open("stoatplus/plugins/$name").use { input ->
                    target.outputStream().use { input.copyTo(it) }
                }
            }
        }
        marker.writeText("The example plugins were copied here once. Delete this file to copy them again.\n")
    }

    private fun evaluate(js: String) {
        scope.launch { webView?.evaluateJavascript(js, null) }
    }

    // ---------- JS -> Kotlin ----------

    @Suppress("unused")
    private class Bridge {
        @JavascriptInterface
        fun resolve(id: Int, value: String?) {
            calls[id]?.complete(Result.success(value ?: "null"))
        }

        @JavascriptInterface
        fun reject(id: Int, message: String?) {
            calls[id]?.complete(Result.failure(Exception(message ?: "error")))
        }

        @JavascriptInterface
        fun toast(text: String) {
            scope.launch { Toast.makeText(app, text, Toast.LENGTH_SHORT).show() }
        }

        @JavascriptInterface
        fun storageGet(key: String): String? = prefs.getString(key, null)

        @JavascriptInterface
        fun storageSet(key: String, value: String) {
            prefs.edit().putString(key, value).apply()
        }

        @JavascriptInterface
        fun storageRemove(key: String) {
            prefs.edit().remove(key).apply()
        }

        @JavascriptInterface
        fun selfId(): String? = StoatAPI.selfId

        @JavascriptInterface
        fun apiRequest(id: Int, method: String, path: String, body: String?) {
            scope.launch(Dispatchers.IO) {
                val (ok, text) = try {
                    val response = StoatHttp.request(path.api()) {
                        this.method = HttpMethod.parse(method.uppercase())
                        if (body != null) setBody(TextContent(body, ContentType.Application.Json))
                    }
                    val text = response.bodyAsText()
                    if (response.status.isSuccess()) true to text
                    else false to "HTTP ${response.status.value}: ${text.take(200)}"
                } catch (e: Exception) {
                    false to (e.message ?: e.toString())
                }
                evaluate("__stoatHostApiDone($id, $ok, ${JsonPrimitive(text)});")
            }
        }

        @JavascriptInterface
        fun log(level: String, text: String) {
            val priority = when (level) {
                "error" -> Log.ERROR
                "warn" -> Log.WARN
                else -> Log.INFO
            }
            Log.println(priority, TAG, text)
        }

        @JavascriptInterface
        fun hooksChanged(send: Int, message: Int, commands: Int) {
            sendHooks = send
            messageHooks = message
            commandHooks = commands
        }
    }
}
