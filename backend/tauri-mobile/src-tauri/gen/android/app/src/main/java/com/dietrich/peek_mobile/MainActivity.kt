package com.dietrich.peek_mobile

import android.content.Intent
import android.content.res.Configuration
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
    appendShareIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    appendShareIntent(intent)
  }

  // Persist ACTION_SEND payload to filesDir/.peek/pending_shares.txt, one entry per line.
  // The frontend drains this on mount and on tauri://focus via the pop_pending_shares
  // tauri command. File-based is deterministic across cold-launch (file outlives the
  // process) and avoids JS-injection timing races with React mount or webview load.
  private fun appendShareIntent(intent: Intent?) {
    if (intent == null) return
    if (intent.action != Intent.ACTION_SEND) return
    if (intent.type?.startsWith("text/") != true) return
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
    if (text.isNullOrBlank()) return
    try {
      val peekDir = File(filesDir, ".peek")
      if (!peekDir.exists()) peekDir.mkdirs()
      val file = File(peekDir, "pending_shares.txt")
      // One entry per line — flatten any embedded newlines first.
      val sanitized = text.replace("\n", " ").replace("\r", "")
      file.appendText("$sanitized\n")
      Log.i("Peek", "appendShareIntent: queued ${sanitized.take(80)}")
    } catch (e: Exception) {
      Log.e("Peek", "appendShareIntent failed", e)
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
