package com.oelpingu.babcamview

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@SuppressLint("SetJavaScriptEnabled")
class MainActivity : Activity() {

    companion object {
        private const val PORT = 80
        private const val CONNECT_TIMEOUT_MS = 1800
        private const val APP_ORIGIN = "https://appassets.androidplatform.net"
        private const val HOME = "$APP_ORIGIN/index.html?manual=1"
        private val MDNS_TYPES = arrayOf(
            "_workstation._tcp.",
            "_device-info._tcp.",
            "_ssh._tcp.",
            "_sftp-ssh._tcp.",
            "_http._tcp.",
            "_https._tcp."
        )
    }

    private lateinit var webView: WebView
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if ((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        webView = WebView(this)
        val container = FrameLayout(this)
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        container.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        setContentView(container)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.setSupportZoom(true)
        settings.setBuiltInZoomControls(true)
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true

        val appVersion = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "0.0.0"
        } catch (_: Exception) { "0.0.0" }
        settings.userAgentString = "${settings.userAgentString} BabyCamView/$appVersion"

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.addJavascriptInterface(Bridge(), "nativeBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (url != null && url.startsWith("http")) {
                    view?.evaluateJavascript(
                        """(function(){if(document.getElementById('bc-zoom'))return;var s=document.createElement('style');s.id='bc-zoom';s.textContent='iframe{touch-action:manipulation}';document.head.appendChild(s)})()""",
                        null
                    )
                }
            }
        }

        webView.loadUrl(HOME)
    }

    private fun settingsFile(): File = File(filesDir, "settings.json")

    private fun defaultSettingsJson(): JSONObject {
        val profile = JSONObject()
        profile.put("name", "BabyCam")
        profile.put("hostname", "babycam")
        profile.put("local_ip", "")
        profile.put("tailscale_ip", "")
        return JSONObject().put("active", "BabyCam").put("profiles", JSONArray().put(profile))
    }

    private fun loadSettingsJson(): JSONObject {
        return try {
            val content = settingsFile().readText()
            JSONObject(content)
        } catch (e: Exception) {
            defaultSettingsJson()
        }
    }

    private fun saveSettingsJson(raw: String) {
        settingsFile().writeText(raw)
    }

    private fun probeIp(ip: String): Boolean {
        return try {
            val clean = ip.substringBefore('%')
            val addr = InetAddress.getByName(clean)
            val socket = Socket()
            try {
                socket.connect(InetSocketAddress(addr, PORT), CONNECT_TIMEOUT_MS)
                true
            } finally {
                socket.close()
            }
        } catch (e: Exception) {
            false
        }
    }

    private fun httpUrlFor(ip: String): String {
        return if (ip.contains(':')) "http://[$ip]:$PORT/" else "http://$ip:$PORT/"
    }

    @Suppress("DEPRECATION")
    private fun mdnsResolve(base: String): String? {
        val nsd = getSystemService(NsdManager::class.java) ?: return null
        val result = AtomicReference<String?>()
        val latch = CountDownLatch(1)
        val handler = Handler(Looper.getMainLooper())
        val start = SystemClock.elapsedRealtime()
        val windowMs = 700L
        val totalTimeoutMs = 3000L

        fun tryType(index: Int) {
            if (result.get() != null || SystemClock.elapsedRealtime() - start > totalTimeoutMs) {
                latch.countDown()
                return
            }
            if (index >= MDNS_TYPES.size) {
                latch.countDown()
                return
            }
            val type = MDNS_TYPES[index]
            val listener = object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(serviceType: String) {}
                override fun onServiceFound(service: NsdServiceInfo) {
                    if (service.serviceName.equals(base, ignoreCase = true)) {
                        try {
                            nsd.resolveService(service, object : NsdManager.ResolveListener {
                                override fun onServiceResolved(info: NsdServiceInfo) {
                                    info.host?.hostAddress?.let { ip ->
                                        if (result.compareAndSet(null, ip)) latch.countDown()
                                    }
                                }

                                override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {}
                            })
                        } catch (e: Exception) { /* ignore */ }
                    }
                }

                override fun onServiceLost(service: NsdServiceInfo) {}
                override fun onDiscoveryStopped(serviceType: String) {}
                override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
                override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            }
            try {
                nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
            } catch (e: Exception) {
                handler.post { tryType(index + 1) }
                return
            }
            handler.postDelayed({
                try {
                    nsd.stopServiceDiscovery(listener)
                } catch (e: Exception) { /* ignore */ }
                tryType(index + 1)
            }, windowMs)
        }

        handler.post { tryType(0) }
        latch.await(totalTimeoutMs + 1000, TimeUnit.MILLISECONDS)
        return result.get()
    }

    private fun sendProgress(message: String) {
        runOnUiThread {
            webView.evaluateJavascript(
                "window.__bcProgress(${JSONObject.quote(message)})",
                null
            )
        }
    }

    private fun testConnection(raw: String): JSONObject {
        val profile = JSONObject(raw)
        val hostname = profile.optString("hostname").trim()
        val candidates = mutableListOf<String>()
        if (hostname.isNotEmpty()) {
            candidates.add(hostname)
            if (!hostname.contains('.')) candidates.add("$hostname.local")
        }
        profile.optString("local_ip").trim().takeIf { it.isNotEmpty() }?.let { candidates.add(it) }
        profile.optString("tailscale_ip").trim().takeIf { it.isNotEmpty() }?.let { candidates.add(it) }

        val errors = JSONArray()
        for (candidate in candidates) {
            val ips = mutableListOf<String>()
            try {
                InetAddress.getAllByName(candidate).forEach { a ->
                    a.hostAddress?.let { if (!ips.contains(it)) ips.add(it) }
                }
            } catch (e: Exception) { /* unresolved */ }

            if (candidate.lowercase().endsWith(".local")) {
                sendProgress("Resolving $candidate (mDNS) ...")
                mdnsResolve(candidate.removeSuffix(".local").removeSuffix("."))?.let { ip ->
                    if (!ips.contains(ip)) ips.add(ip)
                }
            }

            if (ips.isEmpty()) {
                errors.put("$candidate:$PORT not reachable (name did not resolve)")
                continue
            }
            ips.sortBy { if (it.contains(':')) 1 else 0 }
            for (ip in ips) {
                sendProgress("Checking $candidate ($ip:$PORT) ...")
                if (probeIp(ip)) {
                    val url = httpUrlFor(ip)
                    sendProgress("Connected to $url")
                    return JSONObject()
                        .put("ok", true)
                        .put("url", url)
                        .put("winner", candidate)
                        .put("errors", errors)
                }
            }
            errors.put("$candidate:$PORT not reachable")
        }
        if (candidates.isEmpty()) {
            errors.put("Please provide at least one address (hostname, local IP or Tailscale IP).")
        }
        return JSONObject().put("ok", false).put("url", JSONObject.NULL)
            .put("winner", JSONObject.NULL).put("errors", errors)
    }

    private fun httpGet(url: String): String? {
        return try {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 4000
            conn.readTimeout = 4000
            conn.requestMethod = "GET"
            conn.setRequestProperty("User-Agent", "BabyCamView")
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.let {
                BufferedReader(InputStreamReader(it)).use { r -> r.readText() }
            }.orEmpty()
            conn.disconnect()
            text
        } catch (e: Exception) {
            null
        }
    }

    private fun fetchNetworkInfo(rawUrl: String): JSONObject {
        val base = rawUrl.trimEnd('/')
        val info = JSONObject().put("hostname", "").put("ip", "").put("ip_tailscale", "")

        httpGet("$base/api/network")?.let { body ->
            try {
                val parsed = JSONObject(body)
                info.put("hostname", cleanValue(parsed.optString("hostname")))
                info.put("ip", cleanValue(parsed.optString("ip")))
                info.put("ip_tailscale", cleanValue(parsed.optString("ip_tailscale")))
            } catch (e: Exception) { /* fall through */ }
        }

        if (info.getString("hostname").isEmpty() && info.getString("ip").isEmpty() &&
            info.getString("ip_tailscale").isEmpty()
        ) {
            httpGet("$base/settings")?.let { html ->
                info.put("hostname", cleanValue(extractField(html, "id=\"hostnameInput\" value=\"", "\"")))
                info.put("ip", cleanValue(extractField(html, "IP Address</span> <strong>", "</strong>")))
                info.put("ip_tailscale", cleanValue(extractField(html, "Tailscale IP Address</span> <strong>", "</strong>")))
            }
        }
        return info
    }

    private fun cleanValue(value: String): String {
        val trimmed = value.trim()
        val placeholders = listOf("No IP", "Not connected", "unknown")
        return if (trimmed.isEmpty() || placeholders.any { it.equals(trimmed, ignoreCase = true) }) {
            ""
        } else {
            trimmed
        }
    }

    private fun extractField(html: String, start: String, end: String): String {
        val i = html.indexOf(start)
        if (i < 0) return ""
        val rest = html.substring(i + start.length)
        val j = rest.indexOf(end)
        return if (j < 0) "" else rest.substring(0, j).trim()
    }

    private fun navigate(url: String) {
        runOnUiThread { webView.loadUrl(url) }
    }

    private fun appVersion(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "0.0.0"
    } catch (_: Exception) { "0.0.0" }

    private fun checkUpdate(): JSONObject {
        val result = JSONObject()
        result.put("currentVersion", appVersion())
        try {
            val url = URL("https://api.github.com/repos/Manfi21/Babycam-View/releases/latest")
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            conn.setRequestProperty("Accept", "application/vnd.github+json")
            if (conn.responseCode == 200) {
                val body = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
                val json = JSONObject(body)
                result.put("latestVersion", json.optString("tag_name", "").removePrefix("v"))
                result.put("releaseNotes", json.optString("body", ""))
                result.put("releaseUrl", json.optString("html_url", ""))
                val assets = json.optJSONArray("assets")
                if (assets != null) {
                    for (i in 0 until assets.length()) {
                        val a = assets.getJSONObject(i)
                        if (a.optString("name", "").endsWith(".apk")) {
                            result.put("downloadUrl", a.getString("browser_download_url"))
                            break
                        }
                    }
                }
            }
        } catch (_: Exception) {}
        return result
    }

    private fun installUpdate(downloadUrl: String) {
        val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val req = DownloadManager.Request(Uri.parse(downloadUrl))
            .setTitle("BabyCam View Update")
            .setDescription("Downloading update…")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "BabyCamView.apk")
            .setAllowedOverMetered(true)
        val downloadId = dm.enqueue(req)

        Thread {
            var cursor: Cursor? = null
            try {
                while (true) {
                    cursor = dm.query(DownloadManager.Query().setFilterById(downloadId))
                    if (cursor != null && cursor.moveToFirst()) {
                        val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                        if (status == DownloadManager.STATUS_SUCCESSFUL) {
                            val uriStr = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI))
                            val fileUri = Uri.parse(uriStr)
                            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                                setDataAndType(fileUri, "application/vnd.android.package-archive")
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            runOnUiThread { startActivity(installIntent) }
                            break
                        } else if (status == DownloadManager.STATUS_FAILED) {
                            break
                        }
                    }
                    cursor?.close()
                    Thread.sleep(1000)
                }
            } catch (_: Exception) {
            } finally {
                cursor?.close()
            }
        }.start()
    }

    private inner class Bridge {
        @JavascriptInterface
        fun invoke(request: String) {
            val parts = request.split('\u0000', limit = 3)
            val id = parts.getOrNull(0).orEmpty()
            val cmd = parts.getOrNull(1).orEmpty()
            val payload = parts.getOrNull(2) ?: "null"

            executor.execute {
                try {
                    val result = when (cmd) {
                        "load_settings" -> loadSettingsJson().toString()
                        "save_settings" -> {
                            saveSettingsJson(payload)
                            "null"
                        }
                        "test_connection" -> testConnection(payload).toString()
                        "fetch_network_info" -> {
                            val url = JSONTokener(payload).nextValue() as String
                            fetchNetworkInfo(url).toString()
                        }
                        "navigate_to" -> {
                            val url = JSONTokener(payload).nextValue() as String
                            navigate(url)
                            "null"
                        }
                        "check_update" -> checkUpdate().toString()
                        "install_update" -> {
                            val url = JSONTokener(payload).nextValue() as String
                            installUpdate(url)
                            "null"
                        }
                        else -> "null"
                    }
                    runOnUiThread {
                        webView.evaluateJavascript("window.__bcResolve($id, null, $result)", null)
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        webView.evaluateJavascript(
                            "window.__bcResolve($id, ${JSONObject.quote(e.message ?: "error")}, null)",
                            null
                        )
                    }
                }
            }
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        executor.shutdown()
    }
}
