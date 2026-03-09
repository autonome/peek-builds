package com.dietrich.peek_mobile

import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
  // Cached safe-area JS snippet, updated by insets listener
  private var safeAreaJs: String? = null
  private var webViewRef: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
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
