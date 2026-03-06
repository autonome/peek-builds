package com.dietrich.peek_mobile

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // Android WebView does not expose env(safe-area-inset-*) CSS variables,
    // so we bridge them from the native WindowInsets API as CSS custom properties.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val density = view.resources.displayMetrics.density
      val topDp = systemBars.top / density
      val bottomDp = systemBars.bottom / density
      val leftDp = systemBars.left / density
      val rightDp = systemBars.right / density
      val js = """
        document.documentElement.style.setProperty('--android-safe-area-top', '${topDp}px');
        document.documentElement.style.setProperty('--android-safe-area-bottom', '${bottomDp}px');
        document.documentElement.style.setProperty('--android-safe-area-left', '${leftDp}px');
        document.documentElement.style.setProperty('--android-safe-area-right', '${rightDp}px');
      """.trimIndent()
      webView.evaluateJavascript(js, null)
      insets
    }
    ViewCompat.requestApplyInsets(webView)
  }
}
