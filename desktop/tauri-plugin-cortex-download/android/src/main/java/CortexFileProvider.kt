package dev.cortex.download

import androidx.core.content.FileProvider

// Distinct FileProvider subclass so this plugin's manifest <provider> merges under its own
// class-name key: the Android manifest merger keys providers by android:name, and the host app
// already declares a plain androidx.core.content.FileProvider — reusing that class would collide.
class CortexFileProvider : FileProvider()
