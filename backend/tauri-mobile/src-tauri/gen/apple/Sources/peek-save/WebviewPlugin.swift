import UIKit
import WebKit

// WKWebView controller for embedded browser
class EmbeddedWebViewController: UIViewController, WKNavigationDelegate {
    private var webView: WKWebView!
    private var itemId: String = ""

    func configure(url: URL, itemId: String) {
        self.itemId = itemId

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        let request = URLRequest(url: url)
        webView.load(request)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done,
            target: self,
            action: #selector(dismissWebview)
        )

        let backButton = UIBarButtonItem(
            image: UIImage(systemName: "chevron.left"),
            style: .plain,
            target: self,
            action: #selector(goBack)
        )
        let forwardButton = UIBarButtonItem(
            image: UIImage(systemName: "chevron.right"),
            style: .plain,
            target: self,
            action: #selector(goForward)
        )
        let shareButton = UIBarButtonItem(
            image: UIImage(systemName: "square.and.arrow.up"),
            style: .plain,
            target: self,
            action: #selector(shareURL)
        )
        navigationItem.leftBarButtonItems = [backButton, forwardButton, shareButton]
    }

    @objc private func dismissWebview() {
        dismiss(animated: true)
    }

    @objc private func goBack() {
        if webView.canGoBack { webView.goBack() }
    }

    @objc private func goForward() {
        if webView.canGoForward { webView.goForward() }
    }

    @objc private func shareURL() {
        guard let url = webView.url else { return }
        let activityVC = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        present(activityVC, animated: true)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigationItem.title = webView.title ?? webView.url?.host
        if let url = webView.url?.absoluteString {
            print("[WebviewPlugin] Navigated to: \(url) for item: \(itemId)")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("[WebviewPlugin] Navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(.allow)
    }
}

// Navigation delegate for inline webview (must be held strongly)
class InlineWebViewDelegate: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("[WebviewPlugin] Inline webview loaded: \(webView.url?.absoluteString ?? "nil")")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("[WebviewPlugin] Inline webview navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("[WebviewPlugin] Inline webview provisional load failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(.allow)
    }
}

// Global state
private var currentWebViewController: EmbeddedWebViewController?
private var currentInlineWebView: WKWebView?
private var inlineWebViewDelegate: InlineWebViewDelegate?

// C-compatible function to open webview - called from Rust FFI
@_cdecl("webview_plugin_open")
public func webviewPluginOpen(urlPtr: UnsafePointer<CChar>, itemIdPtr: UnsafePointer<CChar>) -> Bool {
    let urlString = String(cString: urlPtr)
    let itemId = String(cString: itemIdPtr)

    print("[WebviewPlugin] open called with URL: \(urlString), itemId: \(itemId)")

    guard let url = URL(string: urlString) else {
        print("[WebviewPlugin] Invalid URL: \(urlString)")
        return false
    }

    DispatchQueue.main.async {
        print("[WebviewPlugin] Creating webview on main thread...")
        let webVC = EmbeddedWebViewController()
        webVC.configure(url: url, itemId: itemId)

        let navController = UINavigationController(rootViewController: webVC)
        navController.modalPresentationStyle = .pageSheet

        if #available(iOS 15, *) {
            navController.sheetPresentationController?.detents = [.medium(), .large()]
            navController.sheetPresentationController?.prefersScrollingExpandsWhenScrolledToEdge = true
            navController.sheetPresentationController?.preferredCornerRadius = 12
        }

        guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let window = windowScene.windows.first,
              let rootVC = window.rootViewController else {
            print("[WebviewPlugin] ERROR: Could not find root view controller")
            return
        }

        var topVC = rootVC
        while let presented = topVC.presentedViewController {
            topVC = presented
        }

        print("[WebviewPlugin] Presenting webview from: \(type(of: topVC))")
        topVC.present(navController, animated: true) {
            print("[WebviewPlugin] Webview presented successfully")
        }
        currentWebViewController = webVC
    }

    return true
}

// C-compatible function to close webview
@_cdecl("webview_plugin_close")
public func webviewPluginClose() {
    DispatchQueue.main.async {
        currentWebViewController?.dismiss(animated: true)
        currentWebViewController = nil
    }
}

// C-compatible function to open inline webview (subview, not modal)
@_cdecl("webview_plugin_open_inline")
public func webviewPluginOpenInline(urlPtr: UnsafePointer<CChar>, topOffset: Double) -> Bool {
    let urlString = String(cString: urlPtr)
    print("[WebviewPlugin] open_inline called with URL: \(urlString), topOffset: \(topOffset)")

    guard let url = URL(string: urlString) else {
        print("[WebviewPlugin] Invalid URL: \(urlString)")
        return false
    }

    DispatchQueue.main.async {
        // Remove any existing inline webview
        currentInlineWebView?.removeFromSuperview()
        currentInlineWebView = nil

        guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let window = windowScene.windows.first,
              let rootView = window.rootViewController?.view else {
            print("[WebviewPlugin] ERROR: Could not find root view")
            return
        }

        // Create WKWebView with Safari-like config
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.allowsBackForwardNavigationGestures = true

        // Set Safari-like user agent so sites don't reject us
        webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1"

        // Set navigation delegate (held strongly in global var)
        let delegate = InlineWebViewDelegate()
        webView.navigationDelegate = delegate
        inlineWebViewDelegate = delegate

        // Add on top of all other subviews
        rootView.addSubview(webView)

        // Position: starts at topOffset (from JS getBoundingClientRect), extends to bottom
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: rootView.topAnchor, constant: CGFloat(topOffset)),
            webView.leadingAnchor.constraint(equalTo: rootView.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: rootView.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: rootView.bottomAnchor)
        ])

        webView.load(URLRequest(url: url))
        currentInlineWebView = webView

        print("[WebviewPlugin] Inline webview added as subview at topOffset: \(topOffset)")
    }

    return true
}

// C-compatible function to close inline webview
@_cdecl("webview_plugin_close_inline")
public func webviewPluginCloseInline() {
    DispatchQueue.main.async {
        currentInlineWebView?.removeFromSuperview()
        currentInlineWebView = nil
        inlineWebViewDelegate = nil
        print("[WebviewPlugin] Inline webview removed")
    }
}
