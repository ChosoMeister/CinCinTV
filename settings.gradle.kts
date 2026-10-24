pluginManagement {
    resolutionStrategy {
        eachPlugin {
            val version = requested.version
            if (version != null) {
                when (requested.id.id) {
                    "com.android.application", "com.android.library", "com.android.test" ->
                        useModule("com.android.tools.build:gradle:$version")
                    "org.jetbrains.kotlin.android" ->
                        useModule("org.jetbrains.kotlin:kotlin-gradle-plugin:$version")
                    "org.jetbrains.kotlin.plugin.compose" ->
                        useModule("org.jetbrains.kotlin:compose-compiler-gradle-plugin:$version")
                    "org.jetbrains.kotlin.plugin.serialization" ->
                        useModule("org.jetbrains.kotlin:kotlin-serialization:$version")
                    "com.google.dagger.hilt.android" ->
                        useModule("com.google.dagger:hilt-android-gradle-plugin:$version")
                    "com.google.devtools.ksp" ->
                        useModule("com.google.devtools.ksp:symbol-processing-gradle-plugin:$version")
                    "androidx.baselineprofile" ->
                        useModule("androidx.benchmark:benchmark-gradle-plugin:$version")
                    "io.sentry.android.gradle" ->
                        useModule("io.sentry:sentry-android-gradle-plugin:$version")
                }
            }
        }
    }
    repositories {
        exclusiveContent {
            forRepository {
                maven {
                    name = "AndroidGradlePluginMirror"
                    url = uri("https://maven.aliyun.com/repository/google")
                }
            }
            filter {
                includeGroup("com.android.tools.build")
            }
        }
        maven("https://maven.myket.ir")
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        maven("https://maven.aliyun.com/repository/public")
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven("https://maven.myket.ir")
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
        maven("https://jitpack.io")
    }
}

rootProject.name = "CinCin TV"
include(":app")
include(":baselineprofile")
