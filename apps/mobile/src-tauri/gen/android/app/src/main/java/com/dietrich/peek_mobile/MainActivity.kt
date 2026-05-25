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
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File

class MainActivity : TauriActivity() {
  // Cached safe-area values (dp), updated by insets listener
  private var safeAreaTopDp: Float = 0f
  private var safeAreaBottomDp: Float = 0f
  private var safeAreaLeftDp: Float = 0f
  private var safeAreaRightDp: Float = 0f
  // Script handle for document-start injection (so we can remove+replace on rotation)
  private var docStartScriptHandle: androidx.webkit.ScriptHandler? = null
  private var webViewRef: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // enableEdgeToEdge() handles setDecorFitsSystemWindows internally; calling it
    // after super.onCreate() is correct for Tauri's activity hierarchy.
    enableEdgeToEdge()
    handleShareIntent(intent)

    // Install the insets listener on the window's root content view so we get
    // reliable dispatches on every layout pass (including rotation). We post so
    // the decor view is fully attached before we request insets.
    window.decorView.post {
      val rootView = window.decorView
      ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, insets ->
        val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        val density = resources.displayMetrics.density
        safeAreaTopDp = systemBars.top / density
        safeAreaBottomDp = systemBars.bottom / density
        safeAreaLeftDp = systemBars.left / density
        safeAreaRightDp = systemBars.right / density
        Log.d("PeekInsets", "root insets top=${systemBars.top}px (${safeAreaTopDp}dp) webViewRef=${webViewRef != null}")
        // If WebView is already created, re-inject into the live document AND
        // update the document-start script so future navigations pick up new insets.
        webViewRef?.let { wv ->
          val js = buildSafeAreaJs(safeAreaTopDp, safeAreaBottomDp, safeAreaLeftDp, safeAreaRightDp)
          wv.evaluateJavascript(js, null)
          updateDocumentStartScript(wv)
        }
        insets
      }
      ViewCompat.requestApplyInsets(rootView)
    }
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

    // Read insets synchronously now — they're already available from our listener
    // (or directly from the decorView if the listener hasn't fired yet).
    if (safeAreaTopDp == 0f) {
      val rootInsets = ViewCompat.getRootWindowInsets(window.decorView)
      if (rootInsets != null) {
        val systemBars = rootInsets.getInsets(WindowInsetsCompat.Type.systemBars())
        val density = webView.resources.displayMetrics.density
        safeAreaTopDp = systemBars.top / density
        safeAreaBottomDp = systemBars.bottom / density
        safeAreaLeftDp = systemBars.left / density
        safeAreaRightDp = systemBars.right / density
        Log.d("PeekInsets", "onWebViewCreate: read insets synchronously top=${safeAreaTopDp}dp")
      }
    }

    // Register a document-start script so the CSS vars are set on EVERY page load,
    // before any app JS runs. This survives chrome-client swaps because it's
    // registered on the WebView itself via the WebViewCompat API.
    // Note: Tauri already uses this mechanism for its own init scripts (see RustWebView).
    updateDocumentStartScript(webView)

    // Belt-and-suspenders: also inject via WebViewClient.onPageFinished so that
    // even if DOCUMENT_START_SCRIPT is unavailable, we catch page loads.
    // We wrap Tauri's existing WebViewClient by delegating to it rather than
    // replacing it (Tauri's client handles asset loading; replacing it breaks the app).
    // Since we can't wrap an existing client without reflection, we rely on
    // the document-start script as primary and the insets listener's evaluateJavascript
    // call (which fires on every insets change after WebView exists) as secondary.
    // If document-start is unavailable we add a standalone client only if Tauri hasn't set one.
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      Log.d("PeekInsets", "DOCUMENT_START_SCRIPT not supported, falling back to evaluateJavascript on load")
      // webViewClient may already be set by Tauri's native code (it registers RustWebViewClient).
      // We must not replace it. Instead, immediately inject and rely on the insets-listener
      // evaluateJavascript() path which fires after each insets change.
      val js = buildSafeAreaJs(safeAreaTopDp, safeAreaBottomDp, safeAreaLeftDp, safeAreaRightDp)
      webView.evaluateJavascript(js, null)
    }
  }

  private fun updateDocumentStartScript(webView: WebView) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    // Remove the old script handle if we have one (rotation / inset change).
    docStartScriptHandle?.remove()
    val js = buildSafeAreaJs(safeAreaTopDp, safeAreaBottomDp, safeAreaLeftDp, safeAreaRightDp)
    Log.d("PeekInsets", "registerDocumentStartScript: top=${safeAreaTopDp}dp js=$js")
    docStartScriptHandle = WebViewCompat.addDocumentStartJavaScript(webView, js, setOf("*"))
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // Re-inject dark mode state when system theme changes
    webViewRef?.let { injectDarkModeState(it) }
  }
}
