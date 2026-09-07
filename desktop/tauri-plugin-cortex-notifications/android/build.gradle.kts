// input:  Android Gradle plugin, Kotlin, Tauri Android
// output: Native notification library and JVM unit tests
// pos:    Android notification library build
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// Android's resource merger rejects folder indexes as drawable files.
val notificationResources = tasks.register<Sync>("prepareNotificationResources") {
    from("src/main/res") { exclude("**/CORTEX.md") }
    into(layout.buildDirectory.dir("generated/cortexNotificationRes"))
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(notificationResources) }

android {
    namespace = "dev.cortex.notifications"
    compileSdk = 36
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }
    sourceSets.getByName("main").res.setSrcDirs(
        listOf(layout.buildDirectory.dir("generated/cortexNotificationRes"))
    )
}

dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
