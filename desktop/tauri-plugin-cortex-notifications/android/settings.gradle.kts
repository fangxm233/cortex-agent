// input:  Tauri Android source path, Gradle repositories
// output: Standalone scoped Android test project
// pos:    Native library standalone test settings
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
    plugins {
        id("com.android.library") version "8.11.0"
        id("org.jetbrains.kotlin.android") version "1.9.25"
    }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "cortex-notifications"
include(":tauri-android")
project(":tauri-android").projectDir = file(
    providers.gradleProperty("tauriAndroidPath").orNull
        ?: error("Pass -PtauriAndroidPath=<tauri crate>/mobile/android")
)
