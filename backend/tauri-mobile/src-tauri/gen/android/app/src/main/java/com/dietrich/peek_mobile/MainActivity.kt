package com.dietrich.peek_mobile

import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import java.io.File

class MainActivity : TauriActivity() {
  // Cached safe-area JS snippet, updated by insets listener
  private var safeAreaJs: String? = null
  private var webViewRef: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    handleShareIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleShareIntent(intent)
  }

  // Persist incoming ACTION_SEND / ACTION_SEND_MULTIPLE payloads to disk under
  // filesDir/.peek/. The frontend drains via pop_pending_shares (text) and
  // pop_pending_image_shares (images) on mount + tauri://focus. File-based is
  // deterministic across cold-launch (files outlive the process) and avoids
  // JS-injection timing races.
  private fun handleShareIntent(intent: Intent?) {
    if (intent == null) return
    val mime = intent.type ?: return
    when (intent.action) {
      Intent.ACTION_SEND -> when {
        mime.startsWith("text/") -> intent.getStringExtra(Intent.EXTRA_TEXT)?.let(::appendText)
        mime.startsWith("image/") -> getParcelableStream(intent)?.let { appendImage(it, mime) }
      }
      Intent.ACTION_SEND_MULTIPLE -> when {
        mime.startsWith("text/") ->
          intent.getStringArrayListExtra(Intent.EXTRA_TEXT)?.forEach(::appendText)
        mime.startsWith("image/") ->
          getParcelableStreamList(intent)?.forEach { appendImage(it, mime) }
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun getParcelableStream(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else
      intent.getParcelableExtra(Intent.EXTRA_STREAM)

  @Suppress("DEPRECATION")
  private fun getParcelableStreamList(intent: Intent): List<Uri>? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)

  private fun appendText(text: String) {
    if (text.isBlank()) return
    try {
      val peekDir = File(filesDir, ".peek")
      peekDir.mkdirs()
      val file = File(peekDir, "pending_shares.txt")
      val sanitized = text.replace("\n", " ").replace("\r", "")
      file.appendText("$sanitized\n")
      Log.i("Peek", "appendText: queued ${sanitized.take(80)}")
    } catch (e: Exception) {
      Log.e("Peek", "appendText failed", e)
    }
  }

  private fun appendImage(uri: Uri, mime: String) {
    try {
      val imagesDir = File(filesDir, ".peek/pending_share_images")
      imagesDir.mkdirs()
      val stem = "${System.currentTimeMillis()}_${kotlin.math.abs(uri.hashCode())}"
      val blob = File(imagesDir, "$stem.bin")
      val meta = File(imagesDir, "$stem.mime")
      contentResolver.openInputStream(uri).use { input ->
        if (input == null) {
          Log.e("Peek", "appendImage: could not open $uri")
          return
        }
        blob.outputStream().use { output -> input.copyTo(output) }
      }
      meta.writeText(mime)
      Log.i("Peek", "appendImage: queued ${blob.absolutePath} (${blob.length()} bytes, $mime)")
    } catch (e: Exception) {
      Log.e("Peek", "appendImage failed", e)
    }
  }

  private fun isSystemDarkMode(): Boolean {
    val nightMode = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
    return nightMode == Configuration.UI_MODE_NIGHT_YES
  }

  private fun buildSafeAreaJs(topDp: Float, bottomDp: Float, leftDp: Float, rightDp: Float): String {
    return """
      document.documentElement.style.setProperty('--safe-area-top', '${topDp}px');
      document.documentElement.style.setProperty('--safe-area-bottom', '${bottomDp}px');
      document.documentElement.style.setProperty('--safe-area-left', '${leftDp}px');
      document.documentElement.style.setProperty('--safe-area-right', '${rightDp}px');
    """.trimIndent()
  }

  private fun injectDarkModeState(webView: WebView) {
    val isDark = isSystemDarkMode()
    webView.evaluateJavascript(
      "window.__ANDROID_DARK_MODE__ = $isDark;",
      null
    )
  }

  override fun onWebViewCreate(webView: WebView) {
    webViewRef = webView

    // Enable WebView dark mode support so prefers-color-scheme media query works.
    // On API 33+ (Android 13), use WebView's built-in algorithmic darkening.
    // On older APIs, use AndroidX WebSettingsCompat.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      webView.settings.isAlgorithmicDarkeningAllowed = true
    } else if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
      WebSettingsCompat.setAlgorithmicDarkeningAllowed(webView.settings, true)
    }

    // Inject safe-area and dark mode via a WebChromeClient, which doesn't conflict
    // with Tauri's RustWebViewClient (they are independent — WebViewClient vs WebChromeClient).
    webView.webChromeClient = object : android.webkit.WebChromeClient() {
      override fun onProgressChanged(view: WebView?, newProgress: Int) {
        super.onProgressChanged(view, newProgress)
        // Inject once the page is mostly loaded
        if (newProgress >= 80 && view != null) {
          safeAreaJs?.let { view.evaluateJavascript(it, null) }
          injectDarkModeState(view)
        }
      }
    }

    // Android WebView does not expose env(safe-area-inset-*) CSS variables,
    // so we bridge them from the native WindowInsets API as CSS custom properties.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val density = view.resources.displayMetrics.density
      val topDp = systemBars.top / density
      val bottomDp = systemBars.bottom / density
      val leftDp = systemBars.left / density
      val rightDp = systemBars.right / density
      safeAreaJs = buildSafeAreaJs(topDp, bottomDp, leftDp, rightDp)
      webView.evaluateJavascript(safeAreaJs!!, null)
      insets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // Re-inject dark mode state when system theme changes
    webViewRef?.let { injectDarkModeState(it) }
  }
}
