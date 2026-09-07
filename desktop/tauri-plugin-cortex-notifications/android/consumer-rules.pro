# input:  Tauri reflection entry points
# output: Preserved plugin and Invoke argument classes
# pos:    Notification library consumer shrinker rules
# >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
-keep class dev.cortex.notifications.NotificationsPlugin { *; }
-keep @app.tauri.annotation.InvokeArg class dev.cortex.notifications.** { *; }
