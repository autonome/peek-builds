import UIKit
import WebKit

// Standalone WKWebView controller - no Tauri dependency
class EmbeddedWebViewController: UIViewController, WKNavigationDelegate {
    private var webView: WKWebView!
    private var itemId: String = ""

    func configure(url: URL, itemId: String) {
        self.itemId = itemId

        // Configure WKWebView
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true

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

        // Load the URL
        let request = URLRequest(url: url)
        webView.load(request)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        // Add Done button
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done,
            target: self,
            action: #selector(dismissWebview)
        )

        // Add navigation buttons
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
        if webView.canGoBack {
            webView.goBack()
        }
    }

    @objc private func goForward() {
        if webView.canGoForward {
            webView.goForward()
        }
    }

    @objc private func shareURL() {
        guard let url = webView.url else { return }
        let activityVC = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        present(activityVC, animated: true)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Update title
        navigationItem.title = webView.title ?? webView.url?.host

        // Log navigation for debugging
        if let url = webView.url?.absoluteString {
            print("[WebviewPlugin] Navigated to: \(url) for item: \(itemId)")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("[WebviewPlugin] Navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Allow all navigation
        decisionHandler(.allow)
    }
}

// Global state for the webview
private var currentWebViewController: EmbeddedWebViewController?

// C-compatible function to open webview
// Called from Rust FFI
@_cdecl("webview_plugin_open")
public func webviewPluginOpen(urlPtr: UnsafePointer<CChar>, itemIdPtr: UnsafePointer<CChar>) -> Bool {
    let urlString = String(cString: urlPtr)
    let itemId = String(cString: itemIdPtr)

    guard let url = URL(string: urlString) else {
        print("[WebviewPlugin] Invalid URL: \(urlString)")
        return false
    }

    DispatchQueue.main.async {
        let webVC = EmbeddedWebViewController()
        webVC.configure(url: url, itemId: itemId)

        let navController = UINavigationController(rootViewController: webVC)
        navController.modalPresentationStyle = .fullScreen

        // Find the top-most view controller to present from
        if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let rootVC = windowScene.windows.first?.rootViewController {
            var topVC = rootVC
            while let presented = topVC.presentedViewController {
                topVC = presented
            }
            topVC.present(navController, animated: true)
            currentWebViewController = webVC
        }
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

// Dummy init function that Rust expects
// This is just a placeholder - the actual functionality uses the C functions above
@_cdecl("init_plugin_webview")
public func initPluginWebview() -> UnsafeMutableRawPointer? {
    print("[WebviewPlugin] Plugin initialized")
    return nil
}
