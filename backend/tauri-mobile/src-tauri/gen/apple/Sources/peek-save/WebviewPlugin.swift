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

// Global state
private var currentWebViewController: EmbeddedWebViewController?

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
