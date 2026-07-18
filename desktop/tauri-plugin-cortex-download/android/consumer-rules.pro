# Keep the plugin class + its @Command methods reachable by the Tauri runtime's reflection.
-keep class dev.cortex.download.** { *; }
