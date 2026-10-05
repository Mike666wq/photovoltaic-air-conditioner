package xyz.bbben.pvac.monitor

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.webkit.*
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/** 固定站点客户端：仅主框架同源消息具有原生保存能力。 */
class MainActivity : ComponentActivity() {
    companion object {
        private const val ORIGIN = "https://pv-ac.bbben.xyz"
        private const val HOME = "$ORIGIN/"
        private const val MAX_BYTES = 1024 * 1024
        private val MIME_TYPES = arrayOf("text/csv", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/pdf")
    }
    private lateinit var web: WebView
    private lateinit var failure: LinearLayout
    private var foreground = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private data class Save(val id: String, val name: String, val bytes: ByteArray)
    private var pendingSave: Save? = null
    private val files = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        fileCallback?.onReceiveValue(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
        fileCallback = null
    }
    private val save = registerForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
        val request = pendingSave
        pendingSave = null
        if (request != null) {
            if (uri == null) saveResult(request.id, "cancelled")
            else {
                // 正文不落应用缓存、不写日志；保存交由系统文档提供者。
                Thread {
                    val status = try {
                        contentResolver.openOutputStream(uri, "wt")?.use { it.write(request.bytes) }
                            ?: throw IllegalStateException("无法打开文档")
                        "saved"
                    } catch (_: Exception) { "failed" }
                    runOnUiThread { saveResult(request.id, status) }
                }.start()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val tools = LinearLayout(this)
        listOf("返回" to { goBack() }, "刷新" to { discardGuard { web.reload() } }, "关于" to { about() }).forEach { (title, action) ->
            tools.addView(Button(this).apply { text = title; setOnClickListener { action() } }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        }
        root.addView(tools)
        val modules = LinearLayout(this)
        listOf("原理图" to "/", "数据分析" to "/analysis", "实时监控" to "/monitoring").forEach { (title, path) ->
            modules.addView(Button(this).apply { text = title; setOnClickListener { navigateModule(path) } }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        }
        root.addView(modules)
        failure = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = android.view.View.GONE
            addView(TextView(this@MainActivity).apply { text = "监控页面加载失败，请检查网络后重试。" })
            addView(Button(this@MainActivity).apply { text = "重试"; setOnClickListener { web.reload() } })
        }
        root.addView(failure)
        web = WebView(this)
        root.addView(web, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            // 系统 SAF 文件选择返回 content://；禁 file://，保留受系统 URI 授权约束的内容读取。
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            userAgentString += " PvAcMonitor/" + BuildConfig.VERSION_NAME
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (trusted(request.url)) return false
                if (request.isForMainFrame && request.url.scheme in listOf("http", "https")) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: ActivityNotFoundException) { }
                }
                return true
            }
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) { failure.visibility = android.view.View.GONE }
            override fun onPageFinished(view: WebView, url: String?) { notifyForeground(); CookieManager.getInstance().flush() }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) failure.visibility = android.view.View.VISIBLE
            }
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && response.statusCode >= 400) failure.visibility = android.view.View.VISIBLE
            }
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                failure.visibility = android.view.View.VISIBLE
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                try { files.launch(MIME_TYPES) } catch (_: Exception) { callback.onReceiveValue(null); fileCallback = null }
                return true
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "pvAcNative", setOf(ORIGIN)) { _, message, source, mainFrame, _ ->
                if (mainFrame && trusted(source)) receive(message.data)
            }
        } else {
            Toast.makeText(this, "请更新 Android System WebView 以启用文件保存", Toast.LENGTH_LONG).show()
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() { goBack() } })
        web.loadUrl(HOME)
    }

    /** 固定模块使用SPA切换，避免整页加载清空导入数据；无需等待云端桥部署。 */
    private fun navigateModule(path: String) {
        if (path !in listOf("/", "/analysis", "/monitoring")) return
        if (!trustedPage()) { discardGuard { web.loadUrl(ORIGIN + path) }; return }
        val target = JSONObject.quote(path)
        web.evaluateJavascript("(() => { if (location.pathname === $target && !location.search) return true; history.pushState({}, '', $target); window.dispatchEvent(new PopStateEvent('popstate')); return true; })()", null)
    }

    private fun trusted(uri: Uri): Boolean = uri.scheme == "https" && uri.host == "pv-ac.bbben.xyz" && (uri.port == -1 || uri.port == 443) && uri.userInfo == null
    private fun trustedPage(): Boolean = web.url?.let { trusted(Uri.parse(it)) } == true
    // 所有脚本均为编译期固定调用；外部消息不能提供脚本或导航路径。
    private fun goBack() {
        if (!trustedPage()) { nativeBack(); return }
        web.evaluateJavascript("Boolean(window.PvAcClient && window.PvAcClient.back())") { handled -> if (handled != "true") nativeBack() }
    }
    private fun nativeBack() { discardGuard { if (web.canGoBack()) web.goBack() else confirm("退出监控？") { finish() } } }
    private fun discardGuard(action: () -> Unit) {
        if (!trustedPage()) { action(); return }
        web.evaluateJavascript("Boolean(!window.PvAcClient || window.PvAcClient.canDiscard())") { allowed ->
            if (allowed == "true") action() else confirm("当前有未保存内容，仍要继续？", action)
        }
    }
    private fun confirm(message: String, action: () -> Unit) {
        AlertDialog.Builder(this).setMessage(message).setNegativeButton("取消", null).setPositiveButton("继续") { _, _ -> action() }.show()
    }
    private fun notifyForeground() {
        if (trustedPage()) web.evaluateJavascript(if (foreground) "window.PvAcClient && window.PvAcClient.setForeground(true)" else "window.PvAcClient && window.PvAcClient.setForeground(false)", null)
    }
    override fun onStart() { super.onStart(); foreground = true; if (::web.isInitialized) { web.onResume(); notifyForeground() } }
    override fun onStop() { foreground = false; notifyForeground(); // 先发送前后台通知；不暂停 WebView，给租约释放请求 best effort 执行机会。
        CookieManager.getInstance().flush(); super.onStop() }
    override fun onDestroy() { fileCallback?.onReceiveValue(null); web.destroy(); super.onDestroy() }
    private fun about() {
        AlertDialog.Builder(this).setTitle("光伏·空调监控")
            .setMessage("客户端 ${BuildConfig.VERSION_NAME}\n构建 SHA：${BuildConfig.BUILD_SHA}\n$HOME\n网页版本请查看页面页眉。")
            .setNeutralButton("发布下载") { _, _ ->
                try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/Mike666wq/photovoltaic-air-conditioner/releases"))) }
                catch (_: ActivityNotFoundException) { Toast.makeText(this, "未找到浏览器", Toast.LENGTH_SHORT).show() }
            }
            .setPositiveButton("确定", null).show()
    }
    private fun receive(raw: String?) {
        if (raw == null || raw.length > MAX_BYTES * 6 + 65536) return
        try {
            val json = JSONObject(raw)
            val type = json.optString("type")
            if (type != "saveText" && type != "copyText") return
            val id = json.optString("id")
            if (id.isBlank() || id.length > 128) return
            val text = json.opt("text") as? String
            if (type == "copyText") {
                if (text == null || text.toByteArray(Charsets.UTF_8).size > MAX_BYTES) {
                    saveResult(id, "failed")
                    return
                }
                // 仅写入用户主动请求的正文；不读取剪贴板、不缓存、不记录。
                val status = try {
                    val clipboard = getSystemService(ClipboardManager::class.java)
                    clipboard.setPrimaryClip(ClipData.newPlainText("光伏·空调监控", text))
                    "saved"
                } catch (_: Exception) { "failed" }
                saveResult(id, status)
                return
            }
            val name = json.optString("fileName")
            if (name.isBlank() || name.length > 180 || name in listOf(".", "..") || name.any { it.isISOControl() || it in "/\\:*?\"<>|" } || text == null) { saveResult(id, "failed"); return }
            val bytes = text.toByteArray(Charsets.UTF_8)
            if (bytes.size > MAX_BYTES || pendingSave != null) { saveResult(id, "failed"); return }
            pendingSave = Save(id, name, bytes)
            try { save.launch(name) } catch (_: Exception) { pendingSave = null; saveResult(id, "failed") }
        } catch (_: Exception) { /* 非法协议消息不回显、不记录正文。 */ }
    }
    private fun saveResult(id: String, status: String) {
        if (trustedPage()) web.evaluateJavascript("window.PvAcClient && window.PvAcClient.onSaveResult(${JSONObject.quote(id)},${JSONObject.quote(status)})", null)
    }
}
