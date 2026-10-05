plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
val buildSha = System.getenv("PVAC_BUILD_SHA") ?: "unknown"
require(buildSha == "unknown" || buildSha.matches(Regex("[0-9a-fA-F]{7,40}"))) { "PVAC_BUILD_SHA 必须是 Git SHA" }
val signingKeys = listOf("PVAC_ANDROID_KEYSTORE", "PVAC_ANDROID_STORE_PASSWORD", "PVAC_ANDROID_KEY_ALIAS", "PVAC_ANDROID_KEY_PASSWORD")
val signingValues = signingKeys.associateWith { System.getenv(it) }
android {
    namespace = "xyz.bbben.pvac.monitor"
    compileSdk = 35
    defaultConfig {
        applicationId = "xyz.bbben.pvac.monitor"
        minSdk = 29
        targetSdk = 35
        versionCode = (System.getenv("PVAC_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("PVAC_VERSION") ?: "0.1.0-dev"
        buildConfigField("String", "BUILD_SHA", "\"$buildSha\"")
    }
    signingConfigs {
        create("production") {
            if (signingValues.values.all { !it.isNullOrBlank() }) {
                storeFile = file(signingValues.getValue(signingKeys[0])!!)
                storePassword = signingValues.getValue(signingKeys[1])
                keyAlias = signingValues.getValue(signingKeys[2])
                keyPassword = signingValues.getValue(signingKeys[3])
            }
        }
    }
    buildTypes { getByName("release") { signingConfig = signingConfigs.getByName("production") } }
    buildFeatures { buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
// 发布任务缺少签名时立即拒绝，不生成可误发布的未签名包。
gradle.taskGraph.whenReady {
    if (allTasks.any { it.name.contains("Release", ignoreCase = true) } && signingValues.values.any { it.isNullOrBlank() }) {
        throw GradleException("Release 必须提供全部 PVAC_ANDROID 签名环境变量")
    }
}
dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.13.0")
}
