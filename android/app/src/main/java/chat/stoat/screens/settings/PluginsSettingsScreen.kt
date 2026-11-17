package chat.stoat.screens.settings

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import chat.stoat.core.designsystem.icons.StoatIcons
import chat.stoat.core.designsystem.icons.painter
import chat.stoat.plugins.PluginEngine
import chat.stoat.plugins.PluginInfo
import chat.stoat.plugins.PluginSetting
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PluginsSettingsScreen(navController: NavController) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val plugins by PluginEngine.plugins.collectAsState()
    val commands by PluginEngine.commands.collectAsState()
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()

    var addMenuOpen by remember { mutableStateOf(false) }
    var urlDialogOpen by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<PluginInfo?>(null) }
    var expandedId by rememberSaveable { mutableStateOf<String?>(null) }

    fun report(result: Result<String>) {
        val text = result.fold(
            onSuccess = { "Installed $it. Turn it on below." },
            onFailure = { "Install failed: ${it.message}" },
        )
        Toast.makeText(context, text, Toast.LENGTH_LONG).show()
    }

    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch { report(PluginEngine.installFromUri(uri)) }
    }

    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(
                scrollBehavior = scrollBehavior,
                title = { Text("Plugins") },
                navigationIcon = {
                    IconButton(onClick = { navController.popBackStack() }) {
                        Icon(painter = StoatIcons.Back.painter(), contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = {
                        scope.launch {
                            PluginEngine.reload()
                            Toast.makeText(context, "Plugins reloaded", Toast.LENGTH_SHORT).show()
                        }
                    }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Reload plugins")
                    }
                    IconButton(onClick = { addMenuOpen = true }) {
                        Icon(Icons.Default.Add, contentDescription = "Add plugin")
                    }
                    DropdownMenu(expanded = addMenuOpen, onDismissRequest = { addMenuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("From a file") },
                            onClick = {
                                addMenuOpen = false
                                pickFile.launch(arrayOf("*/*"))
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("From a link") },
                            onClick = {
                                addMenuOpen = false
                                urlDialogOpen = true
                            },
                        )
                    }
                },
            )
        },
    ) { pv ->
        LazyColumn(
            modifier = Modifier
                .padding(pv)
                .fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item {
                Text(
                    "Plugins run inside the app with access to your account. Only add plugins you trust.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
            }

            if (commands.isNotEmpty()) {
                item {
                    Text(
                        "Commands: " + commands.joinToString("  ") { "/${it.name}" },
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.padding(horizontal = 20.dp),
                    )
                }
            }

            if (plugins.isEmpty()) {
                item {
                    Text(
                        "No plugins yet. Tap + to add one.",
                        modifier = Modifier.padding(20.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            items(plugins, key = { it.id }) { plugin ->
                PluginCard(
                    plugin = plugin,
                    expanded = expandedId == plugin.id,
                    onToggleExpanded = {
                        expandedId = if (expandedId == plugin.id) null else plugin.id
                    },
                    onEnabledChange = { enabled ->
                        scope.launch { PluginEngine.setEnabled(plugin.id, enabled) }
                    },
                    onDelete = { deleting = plugin },
                )
            }

            item { Spacer(Modifier.height(24.dp)) }
        }
    }

    if (urlDialogOpen) {
        var url by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { urlDialogOpen = false },
            title = { Text("Add plugin from a link") },
            text = {
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    singleLine = true,
                    placeholder = { Text("https://example.com/plugin.js") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
            },
            confirmButton = {
                TextButton(
                    enabled = url.isNotBlank(),
                    onClick = {
                        urlDialogOpen = false
                        scope.launch { report(PluginEngine.installFromUrl(url)) }
                    },
                ) { Text("Install") }
            },
            dismissButton = {
                TextButton(onClick = { urlDialogOpen = false }) { Text("Cancel") }
            },
        )
    }

    deleting?.let { plugin ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete ${plugin.name}?") },
            text = { Text("This removes ${plugin.file} and its settings.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    scope.launch { PluginEngine.delete(plugin) }
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { deleting = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun PluginCard(
    plugin: PluginInfo,
    expanded: Boolean,
    onToggleExpanded: () -> Unit,
    onEnabledChange: (Boolean) -> Unit,
    onDelete: () -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        modifier = Modifier
            .padding(horizontal = 16.dp)
            .fillMaxWidth(),
    ) {
        Column(
            Modifier
                .clickable(onClick = onToggleExpanded)
                .padding(16.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(plugin.name, fontWeight = FontWeight.SemiBold)
                    Text(
                        listOfNotNull(
                            "v${plugin.version}",
                            plugin.author.ifEmpty { null },
                            if (!plugin.supported) "${plugin.platforms.joinToString()} only" else null,
                        ).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = plugin.enabled && plugin.supported,
                    enabled = plugin.supported,
                    onCheckedChange = onEnabledChange,
                )
            }
            if (plugin.description.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(plugin.description, style = MaterialTheme.typography.bodyMedium)
            }
            plugin.error?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }

            if (expanded) {
                Spacer(Modifier.height(12.dp))
                HorizontalDivider()
                Spacer(Modifier.height(12.dp))
                if (plugin.settingsSchema.isEmpty()) {
                    Text(
                        "This plugin has no settings.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                plugin.settingsSchema.forEach { (key, def) ->
                    SettingField(plugin, key, def)
                    Spacer(Modifier.height(12.dp))
                }
                Row {
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = onDelete) {
                        Text("Delete plugin", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingField(plugin: PluginInfo, key: String, def: PluginSetting) {
    val scope = rememberCoroutineScope()
    val current = plugin.settings[key]
    val label = def.label ?: key
    fun save(value: JsonPrimitive) {
        scope.launch { PluginEngine.setSetting(plugin.id, key, value) }
    }

    Column {
        when (def.type) {
            "boolean" -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label, modifier = Modifier.weight(1f))
                Switch(
                    checked = current?.jsonPrimitive?.booleanOrNull ?: false,
                    onCheckedChange = { save(JsonPrimitive(it)) },
                )
            }

            "select" -> {
                Text(label, style = MaterialTheme.typography.labelLarge)
                val selected = current?.jsonPrimitive?.contentOrNull
                def.choices().forEach { (value, optionLabel) ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .selectable(selected = value == selected, onClick = { save(JsonPrimitive(value)) }),
                    ) {
                        RadioButton(selected = value == selected, onClick = { save(JsonPrimitive(value)) })
                        Spacer(Modifier.width(4.dp))
                        Text(optionLabel)
                    }
                }
            }

            "number" -> {
                // Local text state so typing isn't reset while the change saves.
                var text by remember(plugin.id, key) {
                    mutableStateOf(current?.jsonPrimitive?.doubleOrNull?.let {
                        if (it % 1.0 == 0.0) it.toLong().toString() else it.toString()
                    } ?: "")
                }
                OutlinedTextField(
                    value = text,
                    onValueChange = {
                        text = it
                        it.toDoubleOrNull()?.let { n -> save(JsonPrimitive(n)) }
                    },
                    label = { Text(label) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            else -> {
                var text by remember(plugin.id, key) {
                    mutableStateOf(current?.jsonPrimitive?.contentOrNull ?: "")
                }
                OutlinedTextField(
                    value = text,
                    onValueChange = {
                        text = it
                        save(JsonPrimitive(it))
                    },
                    label = { Text(label) },
                    singleLine = def.type != "text",
                    minLines = if (def.type == "text") 3 else 1,
                    textStyle = if (def.type == "text") {
                        MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace)
                    } else {
                        MaterialTheme.typography.bodyLarge
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        def.description?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}
