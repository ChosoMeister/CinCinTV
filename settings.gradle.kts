pluginManagement {
    resolutionStrategy {
        eachPlugin {
            if (requested.id.id.startsWith("com.android.") && requested.version != null) {
                useModule("com.android.tools.build:gradle:${requested.version}")
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
        gradlePluginPortal()
        mavenCentral()
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        maven("https://maven.aliyun.com/repository/public")
        maven("https://maven.myket.ir")
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
