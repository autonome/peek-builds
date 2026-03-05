import UIKit
import UniformTypeIdentifiers
import Network
import os.log
import Vision
import NaturalLanguage

private let shareLog = OSLog(subsystem: "com.dietrich.peek-mobile.share", category: "ShareExtension")

// MARK: - Item Types
enum ItemType: String {
    case page = "url"      // Use 'url' to match Rust main app's expected type
    case text = "text"
    case tagset = "tagset"
    case image = "image"
}

// MARK: - View Models (for UI)
struct TagStats {
    var name: String
    var frequency: Int
    var lastUsed: String
    var frecencyScore: Double
}

struct SavedItem {
    var id: String
    var itemType: ItemType
    var url: String?
    var content: String?
    var tags: [String]
    var saved_at: String
    var metadata: [String: Any]?
}

// For backward compatibility
typealias SavedUrl = SavedItem

// MARK: - PeekCore Manager (thin wrapper around PeekCoreFfi)
class PeekCoreManager {
    static let shared = PeekCoreManager()

    private var store: PeekCoreFfi?
    private var profileConfig: FfiProfileConfig?
    private let networkMonitor = NWPathMonitor()
    private var isConnected = false

    private init() {
        setupStore()
        setupNetworkMonitor()
    }

    /// Re-read profile config and reconnect to the DB.
    /// Call this each time the share extension is presented,
    /// since iOS may keep the extension process (and this singleton)
    /// alive across invocations — a profile switch in the main app
    /// would otherwise go unnoticed.
    func reloadProfile() {
        setupStore()
    }

    private func setupStore() {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: "group.com.dietrich.peek-mobile"
        ) else {
            print("[PeekCore] Failed to get App Group container")
            return
        }

        let basePath = containerURL.path
        profileConfig = ffiLoadProfileConfig(basePath: basePath)

        do {
            let dbPath = try ffiGetDbPathForProfile(basePath: basePath)
            store = try PeekCoreFfi(dbPath: dbPath)
        } catch {
            print("[PeekCore] Failed to initialize store: \(error)")
        }
    }

    private func setupNetworkMonitor() {
        networkMonitor.pathUpdateHandler = { [weak self] path in
            self?.isConnected = (path.status == .satisfied)
        }
        networkMonitor.start(queue: DispatchQueue.global(qos: .background))
    }

    // MARK: - Tag Operations

    func loadTags() -> [TagStats] {
        guard let store = store else { return [] }
        do {
            let ffiTags = try store.getTagsByFrecency()
            return ffiTags.map { TagStats(name: $0.name, frequency: Int($0.frequency), lastUsed: $0.lastUsed, frecencyScore: $0.frecencyScore) }
        } catch {
            print("[PeekCore] Failed to load tags: \(error)")
            return []
        }
    }

    func loadTagsWithDomainBoost(forDomain domain: String?) -> [TagStats] {
        guard let store = store else { return [] }
        guard let domain = domain else {
            return loadTags()
        }

        // Use the URL-based frecency method which applies domain affinity boost
        // We need a representative URL for the domain to trigger the boost
        let representativeUrl = "https://\(domain)/"
        do {
            let ffiTags = try store.getTagsByFrecencyForUrl(url: representativeUrl)
            return ffiTags.map { TagStats(name: $0.name, frequency: Int($0.frequency), lastUsed: $0.lastUsed, frecencyScore: $0.frecencyScore) }
        } catch {
            print("[PeekCore] Failed to load tags with domain boost: \(error)")
            return loadTags()
        }
    }

    // MARK: - URL Operations

    func findExistingUrl(_ url: String) -> SavedItem? {
        guard let store = store else { return nil }
        do {
            guard let ffiItem = try store.findExistingUrl(url: url) else { return nil }
            return SavedItem(
                id: ffiItem.id,
                itemType: .page,
                url: ffiItem.url,
                content: nil,
                tags: ffiItem.tags,
                saved_at: ffiItem.savedAt
            )
        } catch {
            print("[PeekCore] Failed to find URL: \(error)")
            return nil
        }
    }

    // MARK: - Save Operations

    func saveUrl(url: String, tags: [String], metadata: [String: Any]?, completion: @escaping () -> Void) {
        guard let store = store else {
            completion()
            return
        }

        let metadataJson = serializeMetadata(metadata)

        do {
            let result = try store.saveUrl(url: url, tags: tags, metadataJson: metadataJson)
            print("[PeekCore] Saved URL: \(result.itemId) (new: \(result.isNew))")

            // Push to webhook
            let savedAt = ISO8601DateFormatter.shared.string(from: Date())
            pushToWebhook(urlId: result.itemId, urlString: url, tags: tags, metadata: metadata, savedAt: savedAt, completion: completion)
        } catch {
            print("[PeekCore] Failed to save URL: \(error)")
            completion()
        }
    }

    func saveText(content: String, tags: [String], metadata: [String: Any]?, completion: @escaping () -> Void) {
        guard let store = store else {
            completion()
            return
        }

        let metadataJson = serializeMetadata(metadata)

        do {
            let itemId = try store.saveText(content: content, tags: tags, metadataJson: metadataJson)
            print("[PeekCore] Saved text: \(itemId)")

            // Push to webhook
            let savedAt = ISO8601DateFormatter.shared.string(from: Date())
            pushTextToWebhook(textId: itemId, content: content, tags: tags, metadata: metadata, savedAt: savedAt, completion: completion)
        } catch {
            print("[PeekCore] Failed to save text: \(error)")
            completion()
        }
    }

    func saveImage(imageData: Data, mimeType: String, width: Int?, height: Int?, thumbnail: Data?, sourceUrl: String?, tags: [String], metadata: [String: Any]?, completion: @escaping (_ imageId: String?) -> Void) {
        guard let store = store else {
            completion(nil)
            return
        }

        // Merge source URL and dimensions into metadata
        var combinedMetadata = metadata ?? [:]
        if let sourceUrl = sourceUrl {
            combinedMetadata["sourceUrl"] = sourceUrl
        }
        if let width = width {
            combinedMetadata["width"] = width
        }
        if let height = height {
            combinedMetadata["height"] = height
        }
        combinedMetadata["mimeType"] = mimeType

        let metadataJson = serializeMetadata(combinedMetadata)

        do {
            let itemId = try store.saveImage(
                imageBytes: imageData,
                mimeType: mimeType,
                tags: tags,
                metadataJson: metadataJson,
                thumbnailBytes: thumbnail,
                width: width.map { UInt32($0) },
                height: height.map { UInt32($0) }
            )
            print("[PeekCore] Saved image: \(itemId)")

            // Set completion immediately — don't wait for webhook
            completion(itemId)

            // Push to webhook (fire-and-forget)
            let savedAt = ISO8601DateFormatter.shared.string(from: Date())
            pushImageToWebhook(imageId: itemId, sourceUrl: sourceUrl, tags: tags, metadata: combinedMetadata, savedAt: savedAt) { }
        } catch {
            print("[PeekCore] Failed to save image: \(error)")
            completion(nil)
        }
    }

    func updateImageTags(imageId: String, tags: [String], completion: @escaping () -> Void) {
        guard let store = store else {
            completion()
            return
        }

        do {
            try store.updateItemTags(itemId: imageId, tags: tags)
            print("[PeekCore] Updated image tags for \(imageId)")
            completion()
        } catch {
            print("[PeekCore] Failed to update image tags: \(error)")
            completion()
        }
    }

    // Debug: write trace to app group container file
    func debugLog(_ msg: String) {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: "group.com.dietrich.peek-mobile"
        ) else { return }
        let logFile = containerURL.appendingPathComponent("share-debug.log")
        let timestamp = ISO8601DateFormatter.shared.string(from: Date())
        let line = "[\(timestamp)] \(msg)\n"
        if let handle = try? FileHandle(forWritingTo: logFile) {
            handle.seekToEndOfFile()
            handle.write(line.data(using: .utf8)!)
            handle.closeFile()
        } else {
            try? line.write(to: logFile, atomically: true, encoding: .utf8)
        }
    }

    func updateImageTagsAndMetadata(imageId: String, tags: [String], metadata: [String: Any], completion: @escaping () -> Void) {
        debugLog("updateImageTagsAndMetadata called: imageId=\(imageId), metadataKeys=\(metadata.keys.sorted())")

        guard let store = store else {
            debugLog("updateImageTagsAndMetadata: store is NIL")
            completion()
            return
        }

        do {
            try store.updateItemTags(itemId: imageId, tags: tags)
            debugLog("updateItemTags OK")

            if !metadata.isEmpty {
                if let jsonData = try? JSONSerialization.data(withJSONObject: metadata),
                   let jsonStr = String(data: jsonData, encoding: .utf8) {
                    debugLog("updateItemMetadata calling with \(jsonStr.count) chars")
                    try store.updateItemMetadata(itemId: imageId, metadataJson: jsonStr)
                    debugLog("updateItemMetadata OK")
                } else {
                    debugLog("JSON serialization FAILED for keys: \(metadata.keys.sorted())")
                }
            } else {
                debugLog("metadata is empty, skipping update")
            }

            completion()
        } catch {
            debugLog("updateImageTagsAndMetadata CAUGHT ERROR: \(error)")
            completion()
        }
    }

    /// Save OCR/vision text as item content so it's visible in the main app.
    func getItemContent(itemId: String) -> String? {
        do {
            return try store?.getItemContent(itemId: itemId)
        } catch {
            debugLog("getItemContent error: \(error)")
            return nil
        }
    }

    func updateItemContent(itemId: String, content: String) {
        do {
            try store?.updateItemContent(itemId: itemId, content: content)
            debugLog("updateItemContent OK (\(content.count) chars)")
        } catch {
            debugLog("updateItemContent error: \(error)")
        }
    }

    /// Force WAL checkpoint so main app sees share extension writes.
    func checkpoint() {
        do {
            try store?.checkpoint()
        } catch {
            debugLog("checkpoint error: \(error)")
        }
    }

    // MARK: - Thumbnail Generation (UIKit — stays in Swift)

    func generateThumbnail(from imageData: Data, maxSize: CGFloat = 200) -> Data? {
        guard let image = UIImage(data: imageData) else { return nil }

        let scale = min(maxSize / image.size.width, maxSize / image.size.height)
        if scale >= 1 {
            // Image is already small enough
            return image.jpegData(compressionQuality: 0.7)
        }

        let newSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        UIGraphicsBeginImageContextWithOptions(newSize, false, 1.0)
        image.draw(in: CGRect(origin: .zero, size: newSize))
        let thumbnail = UIGraphicsGetImageFromCurrentImageContext()
        UIGraphicsEndImageContext()

        return thumbnail?.jpegData(compressionQuality: 0.7)
    }

    // MARK: - Metadata Helpers

    private func serializeMetadata(_ metadata: [String: Any]?) -> String? {
        guard let metadata = metadata, !metadata.isEmpty else { return nil }
        guard let jsonData = try? JSONSerialization.data(withJSONObject: metadata),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            return nil
        }
        return jsonString
    }

    // MARK: - Webhook Push (HTTP networking stays in Swift)

    private func getWebhookUrl() -> String? {
        guard let sync = profileConfig?.sync else { return nil }
        return sync.serverUrl.isEmpty ? nil : sync.serverUrl
    }

    private func getWebhookApiKey() -> String? {
        guard let sync = profileConfig?.sync else { return nil }
        return sync.apiKey.isEmpty ? nil : sync.apiKey
    }

    private func pushToWebhook(urlId: String, urlString: String, tags: [String], metadata: [String: Any]?, savedAt: String, completion: @escaping () -> Void) {
        guard isConnected else {
            print("[Webhook] Offline - skipping webhook push")
            completion()
            return
        }

        guard let webhookUrlString = getWebhookUrl()?.trimmingCharacters(in: .whitespaces), !webhookUrlString.isEmpty else {
            print("[Webhook] No webhook URL configured")
            completion()
            return
        }

        guard let webhookUrl = URL(string: webhookUrlString) else {
            print("[Webhook] Invalid webhook URL: \(webhookUrlString)")
            completion()
            return
        }

        print("[Webhook] Pushing URL to: \(webhookUrlString)")

        var urlItem: [String: Any] = [
            "id": urlId,
            "url": urlString,
            "tags": tags,
            "saved_at": savedAt
        ]

        if let metadata = metadata, !metadata.isEmpty {
            urlItem["metadata"] = metadata
        }

        let payload: [String: Any] = [
            "urls": [urlItem],
            "texts": [],
            "tagsets": []
        ]

        sendWebhookRequest(to: webhookUrl, payload: payload, completion: completion)
    }

    private func pushTextToWebhook(textId: String, content: String, tags: [String], metadata: [String: Any]?, savedAt: String, completion: @escaping () -> Void) {
        guard isConnected else {
            print("[Webhook] Offline - skipping webhook push")
            completion()
            return
        }

        guard let webhookUrlString = getWebhookUrl()?.trimmingCharacters(in: .whitespaces), !webhookUrlString.isEmpty else {
            print("[Webhook] No webhook URL configured")
            completion()
            return
        }

        guard let webhookUrl = URL(string: webhookUrlString) else {
            print("[Webhook] Invalid webhook URL: \(webhookUrlString)")
            completion()
            return
        }

        print("[Webhook] Pushing text to: \(webhookUrlString)")

        var textItem: [String: Any] = [
            "id": textId,
            "content": content,
            "tags": tags,
            "saved_at": savedAt
        ]

        if let metadata = metadata, !metadata.isEmpty {
            textItem["metadata"] = metadata
        }

        let payload: [String: Any] = [
            "urls": [],
            "texts": [textItem],
            "tagsets": []
        ]

        sendWebhookRequest(to: webhookUrl, payload: payload, completion: completion)
    }

    private func pushImageToWebhook(imageId: String, sourceUrl: String?, tags: [String], metadata: [String: Any]?, savedAt: String, completion: @escaping () -> Void) {
        guard isConnected else {
            print("[Webhook] Offline - skipping webhook push")
            completion()
            return
        }

        guard let webhookUrlString = getWebhookUrl()?.trimmingCharacters(in: .whitespaces), !webhookUrlString.isEmpty else {
            print("[Webhook] No webhook URL configured")
            completion()
            return
        }

        guard let webhookUrl = URL(string: webhookUrlString) else {
            print("[Webhook] Invalid webhook URL: \(webhookUrlString)")
            completion()
            return
        }

        print("[Webhook] Pushing image to: \(webhookUrlString)")

        var imageItem: [String: Any] = [
            "id": imageId,
            "tags": tags,
            "saved_at": savedAt
        ]

        if let sourceUrl = sourceUrl {
            imageItem["source_url"] = sourceUrl
        }

        if let metadata = metadata, !metadata.isEmpty {
            imageItem["metadata"] = metadata
        }

        let payload: [String: Any] = [
            "urls": [],
            "texts": [],
            "tagsets": [],
            "images": [imageItem]
        ]

        sendWebhookRequest(to: webhookUrl, payload: payload, completion: completion)
    }

    private func sendWebhookRequest(to webhookUrl: URL, payload: [String: Any], completion: @escaping () -> Void) {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload) else {
            print("[Webhook] Failed to serialize payload")
            completion()
            return
        }

        var request = URLRequest(url: webhookUrl)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = jsonData

        if let apiKey = getWebhookApiKey()?.trimmingCharacters(in: .whitespaces), !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                print("[Webhook] Push failed: \(error)")
            } else if let httpResponse = response as? HTTPURLResponse {
                if httpResponse.statusCode >= 200 && httpResponse.statusCode < 300 {
                    print("[Webhook] Push successful")
                } else {
                    print("[Webhook] Push returned error: \(httpResponse.statusCode)")
                }
            }
            completion()
        }.resume()
    }
}

// MARK: - ISO8601 Formatter Extension
extension ISO8601DateFormatter {
    static let shared: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

// MARK: - URL Domain Extraction
extension String {
    func extractDomain() -> String? {
        guard let url = URL(string: self),
              let host = url.host else {
            return nil
        }
        // Remove www. prefix if present
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// Normalize URL by ensuring trailing slash on bare authority URLs.
    /// "https://example.com" -> "https://example.com/"
    /// "https://example.com/path" is left unchanged.
    func normalizeURL() -> String {
        guard let url = URL(string: self),
              let scheme = url.scheme,
              (scheme == "http" || scheme == "https") else {
            return self
        }
        // If path is empty, add trailing slash
        if url.path.isEmpty || url.path == "" {
            return self.hasSuffix("/") ? self : self + "/"
        }
        return self
    }
}

// MARK: - Vision Analysis Results
struct VisionAnalysisResult {
    var ocrText: String?
    var barcodes: [String]
    var entities: VisionEntities

    struct VisionEntities {
        var people: [String]
        var places: [String]
        var organizations: [String]
        var dates: [String]
        var urls: [String]
        var phones: [String]

        func allTags() -> [String] {
            var tags: [String] = []
            if !people.isEmpty { tags.append(contentsOf: people.prefix(3).map { $0.lowercased() }) }
            if !places.isEmpty { tags.append(contentsOf: places.prefix(3).map { $0.lowercased() }) }
            if !organizations.isEmpty { tags.append(contentsOf: organizations.prefix(3).map { $0.lowercased() }) }
            return tags
        }
    }

    func toMetadata() -> [String: Any] {
        var result: [String: Any] = [:]
        if let text = ocrText, !text.isEmpty {
            result["ocrText"] = text
        }
        if !barcodes.isEmpty {
            result["barcodes"] = barcodes
        }
        var entitiesDict: [String: Any] = [:]
        if !entities.people.isEmpty { entitiesDict["people"] = entities.people }
        if !entities.places.isEmpty { entitiesDict["places"] = entities.places }
        if !entities.organizations.isEmpty { entitiesDict["organizations"] = entities.organizations }
        if !entities.dates.isEmpty { entitiesDict["dates"] = entities.dates }
        if !entities.urls.isEmpty { entitiesDict["urls"] = entities.urls }
        if !entities.phones.isEmpty { entitiesDict["phones"] = entities.phones }
        if !entitiesDict.isEmpty {
            result["entities"] = entitiesDict
        }
        return result
    }
}

// MARK: - Vision Analyzer
class VisionAnalyzer {

    /// Downscale image to max dimension for memory-safe processing.
    /// Always renders through a graphics context to handle HEIC/CIImage-backed UIImages
    /// where .cgImage returns nil.
    static func downscaleImage(_ image: UIImage, maxDimension: CGFloat = 2048) -> CGImage? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(maxDimension / size.width, maxDimension / size.height, 1.0)
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: newSize)
        let rendered = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: newSize))
        }
        return rendered.cgImage
    }

    /// Run Vision analysis on image data — must be called on a background queue
    /// Extension memory limit is ~220MB. We must minimize peak memory usage.
    /// Uses CGImageSource thumbnail API to decode at reduced size without
    /// fully decompressing the original image (avoids 30-50MB HEIC decode).
    static func analyze(imageData: Data, completion: @escaping (VisionAnalysisResult?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool {
                // Use CGImageSource to create a thumbnail directly from compressed data.
                // This decodes only enough pixels for the thumbnail size, avoiding the
                // full HEIC decompression that UIImage(data:) would trigger.
                guard let source = CGImageSourceCreateWithData(imageData as CFData, nil) else {
                    os_log("Vision: Cannot create image source from data (%d bytes)", log: OSLog.default, type: .error, imageData.count)
                    DispatchQueue.main.async { completion(nil) }
                    return
                }
                // Use 2048px for Vision analysis — enough for good OCR/barcode detection
                // while staying well under the 220MB extension memory limit.
                // (2048x2048x4 = 16MB bitmap vs ~195MB for full 48MP)
                let thumbOpts: [CFString: Any] = [
                    kCGImageSourceThumbnailMaxPixelSize: 2048,
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true
                ]
                guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOpts as CFDictionary) else {
                    os_log("Vision: Cannot create thumbnail from image source", log: OSLog.default, type: .error)
                    DispatchQueue.main.async { completion(nil) }
                    return
                }
                let requestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])

                // OCR request — .fast for memory safety in extension
                let textRequest = VNRecognizeTextRequest()
                textRequest.recognitionLevel = .fast
                textRequest.usesLanguageCorrection = false

                // Barcode request
                let barcodeRequest = VNDetectBarcodesRequest()

                do {
                    try requestHandler.perform([textRequest, barcodeRequest])
                } catch {
                    os_log("Vision: Analysis failed: %{public}@", log: OSLog.default, type: .error, error.localizedDescription)
                    DispatchQueue.main.async { completion(nil) }
                    return
                }

                // Extract OCR text
                var ocrText: String?
                if let observations = textRequest.results {
                    let lines = observations.compactMap { $0.topCandidates(1).first?.string }
                    if !lines.isEmpty {
                        ocrText = lines.joined(separator: "\n")
                    }
                }

                // Extract barcodes
                var barcodes: [String] = []
                if let observations = barcodeRequest.results {
                    for obs in observations {
                        if let payload = obs.payloadStringValue {
                            barcodes.append(payload)
                        }
                    }
                }

                // NLP entity extraction from OCR text
                var entities = VisionAnalysisResult.VisionEntities(
                    people: [], places: [], organizations: [],
                    dates: [], urls: [], phones: []
                )

                if let text = ocrText, !text.isEmpty {
                    // NLTagger for named entities
                    let tagger = NLTagger(tagSchemes: [.nameType])
                    tagger.string = text
                    let options: NLTagger.Options = [.omitWhitespace, .omitPunctuation]

                    tagger.enumerateTags(in: text.startIndex..<text.endIndex, unit: .word, scheme: .nameType, options: options) { tag, range in
                        let entity = String(text[range])
                        switch tag {
                        case .personalName:
                            if !entities.people.contains(entity) { entities.people.append(entity) }
                        case .placeName:
                            if !entities.places.contains(entity) { entities.places.append(entity) }
                        case .organizationName:
                            if !entities.organizations.contains(entity) { entities.organizations.append(entity) }
                        default:
                            break
                        }
                        return true
                    }

                    // NSDataDetector for dates, URLs, phones
                    let detectorTypes: NSTextCheckingResult.CheckingType = [.date, .link, .phoneNumber]
                    if let detector = try? NSDataDetector(types: detectorTypes.rawValue) {
                        let nsRange = NSRange(text.startIndex..., in: text)
                        let matches = detector.matches(in: text, range: nsRange)
                        for match in matches {
                            if match.resultType == .date, let date = match.date {
                                let formatted = ISO8601DateFormatter.shared.string(from: date)
                                if !entities.dates.contains(formatted) { entities.dates.append(formatted) }
                            } else if match.resultType == .link, let url = match.url {
                                let urlStr = url.absoluteString
                                if !entities.urls.contains(urlStr) { entities.urls.append(urlStr) }
                            } else if match.resultType == .phoneNumber, let phone = match.phoneNumber {
                                if !entities.phones.contains(phone) { entities.phones.append(phone) }
                            }
                        }
                    }
                }

                let result = VisionAnalysisResult(
                    ocrText: ocrText,
                    barcodes: barcodes,
                    entities: entities
                )

                DispatchQueue.main.async { completion(result) }
            }
        }
    }
}

// MARK: - ShareViewController
class ShareViewController: UIViewController, UITextViewDelegate {
    var sharedURL: String?
    var sharedText: String?
    var sharedImageData: Data?
    var sharedImageMimeType: String?
    var sharedImageSourceUrl: String?
    var sharedItemType: ItemType = .page
    var sharedMetadata: [String: Any] = [:]  // Captured metadata from share extension
    var selectedTags: Set<String> = []
    var availableTags: [TagStats] = []
    var tagFilterText = ""
    var existingSavedItem: SavedItem?
    var savedImageId: String?  // Track saved image ID to prevent duplicates
    var isSavingImage = false  // Guard against concurrent image saves
    var pendingImageUrl: String?  // Store image URL when seen, for use by image handler
    var visionResult: VisionAnalysisResult?
    var isAnalyzing = false

    let scrollView = UIScrollView()
    let contentStackView = UIStackView()
    let contentTextView = UITextView()  // Editable content (URL, text, or image description)
    let imagePreviewView = UIImageView()  // Shows image preview

    // Selected tags at top - self-sizing
    let selectedTagsCollectionView: SelfSizingCollectionView = {
        let layout = LeftAlignedFlowLayout()
        layout.estimatedItemSize = UICollectionViewFlowLayout.automaticSize
        layout.minimumInteritemSpacing = PeekTheme.spacingSM
        layout.minimumLineSpacing = PeekTheme.spacingSM
        layout.sectionInset = .zero
        let cv = SelfSizingCollectionView(frame: .zero, collectionViewLayout: layout)
        cv.contentInset = .zero
        cv.contentInsetAdjustmentBehavior = .never
        return cv
    }()

    // Unused tags at bottom - self-sizing
    let unusedTagsCollectionView: SelfSizingCollectionView = {
        let layout = LeftAlignedFlowLayout()
        layout.estimatedItemSize = UICollectionViewFlowLayout.automaticSize
        layout.minimumInteritemSpacing = PeekTheme.spacingSM
        layout.minimumLineSpacing = PeekTheme.spacingSM
        layout.sectionInset = .zero
        let cv = SelfSizingCollectionView(frame: .zero, collectionViewLayout: layout)
        cv.contentInset = .zero
        cv.contentInsetAdjustmentBehavior = .never
        return cv
    }()

    let newTagTextField = UITextField()
    let addTagButton = UIButton(type: .system)
    let closeButton = UIButton(type: .system)
    let statusLabel = UILabel()

    let noTagsLabel = UILabel()
    let inputContainerView = UIView()

    // Vision analysis UI
    let analyzeButton = UIButton(type: .system)
    let analyzeSpinner = UIActivityIndicatorView(style: .medium)
    let visionResultsContainer = UIStackView()
    let ocrTextView = UITextView()
    let ocrShowMoreButton = UIButton(type: .system)
    let barcodesLabel = UILabel()
    let suggestedTagsCollectionView: SelfSizingCollectionView = {
        let layout = LeftAlignedFlowLayout()
        layout.estimatedItemSize = UICollectionViewFlowLayout.automaticSize
        layout.minimumInteritemSpacing = PeekTheme.spacingSM
        layout.minimumLineSpacing = PeekTheme.spacingSM
        layout.sectionInset = .zero
        let cv = SelfSizingCollectionView(frame: .zero, collectionViewLayout: layout)
        cv.contentInset = .zero
        cv.contentInsetAdjustmentBehavior = .never
        return cv
    }()
    var suggestedTags: [String] = []
    var isOcrExpanded = false

    override func viewDidLoad() {
        super.viewDidLoad()

        // Re-read profile config every time the share sheet opens.
        // iOS may keep the extension process alive between invocations,
        // so the singleton could hold a stale profile / DB path.
        PeekCoreManager.shared.reloadProfile()

        view.backgroundColor = PeekTheme.bg

        setupUI()
        setupGestures()
        loadSharedContent()
        loadTags()
    }

    private func setupGestures() {
        // Tap empty area to dismiss
        let tapToDismiss = UITapGestureRecognizer(target: self, action: #selector(handleTapToDismiss(_:)))
        tapToDismiss.cancelsTouchesInView = false
        tapToDismiss.delegate = self
        view.addGestureRecognizer(tapToDismiss)
    }

    @objc private func handleTapToDismiss(_ gesture: UITapGestureRecognizer) {
        let location = gesture.location(in: view)

        // Check if tap is below the content (in the empty area)
        let contentBottom = scrollView.frame.origin.y + contentStackView.frame.maxY + 20
        if location.y > contentBottom {
            closePressed()
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        configureSheetPresentation()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        newTagTextField.becomeFirstResponder()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updatePreferredContentSize()
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) {
            // Update cgColor-based borders which don't respond to dynamic colors automatically
            newTagTextField.layer.borderColor = PeekTheme.border.cgColor
            contentTextView.layer.borderColor = PeekTheme.border.cgColor
            ocrTextView.layer.borderColor = PeekTheme.border.cgColor
        }
    }

    private func configureSheetPresentation() {
        // For Share Extensions, we use preferredContentSize instead of UISheetPresentationController
        // because iOS controls the presentation, not our code
        updatePreferredContentSize()
    }

    private func updatePreferredContentSize() {
        // Calculate the actual content height needed
        view.layoutIfNeeded()

        let contentHeight = contentStackView.systemLayoutSizeFitting(
            CGSize(width: view.bounds.width - (PeekTheme.paddingH * 2), height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel
        ).height

        // Add padding: header top margin (spacingMD) + header height (44) + content top (spacingMD) + bottom (paddingH) + safe area
        let safeAreaBottom = view.safeAreaInsets.bottom
        let totalHeight = contentHeight + PeekTheme.spacingMD + 44 + PeekTheme.spacingMD + PeekTheme.paddingH + safeAreaBottom

        // Clamp between min and max
        let minHeight: CGFloat = 250
        let maxHeight = UIScreen.main.bounds.height * 0.85
        let finalHeight = min(max(totalHeight, minHeight), maxHeight)

        // Set preferredContentSize - this is how Share Extensions tell iOS what size they want
        let newSize = CGSize(width: view.bounds.width, height: finalHeight)
        if preferredContentSize != newSize {
            preferredContentSize = newSize
        }
    }

    func setupUI() {
        // Header with close button
        let headerView = UIView()
        headerView.translatesAutoresizingMaskIntoConstraints = false
        headerView.backgroundColor = PeekTheme.bg
        view.addSubview(headerView)


        // Close button (✕) on the RIGHT side of the header
        var closeBtnConfig = UIButton.Configuration.filled()
        closeBtnConfig.contentInsets = NSDirectionalEdgeInsets(top: PeekTheme.buttonPaddingV, leading: PeekTheme.buttonPaddingH, bottom: PeekTheme.buttonPaddingV, trailing: PeekTheme.buttonPaddingH)
        closeBtnConfig.baseBackgroundColor = PeekTheme.accent
        closeBtnConfig.baseForegroundColor = PeekTheme.bg
        closeBtnConfig.cornerStyle = .fixed
        closeBtnConfig.background.cornerRadius = PeekTheme.buttonCornerRadius
        closeBtnConfig.title = "\u{00D7}"  // multiplication sign ✕
        closeBtnConfig.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var outgoing = incoming
            outgoing.font = PeekTheme.inputMedium
            return outgoing
        }
        closeButton.configuration = closeBtnConfig
        closeButton.addTarget(self, action: #selector(closePressed), for: .touchUpInside)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        headerView.addSubview(closeButton)

        // Title label on the TOP LEFT
        let titleLabel = UILabel()
        titleLabel.text = "Peek"
        titleLabel.font = PeekTheme.mono(size: 22, weight: .semibold)
        titleLabel.textColor = PeekTheme.text
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        headerView.addSubview(titleLabel)

        // Status label (shows "✓ Saved") — RIGHT-ALIGNED before close button
        statusLabel.font = PeekTheme.captionMedium
        statusLabel.textColor = PeekTheme.success
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.alpha = 0
        headerView.addSubview(statusLabel)

        // Analyze button (text.viewfinder icon only) — in header, adjacent to close button
        var analyzeBtnConfig = UIButton.Configuration.filled()
        analyzeBtnConfig.contentInsets = NSDirectionalEdgeInsets(top: PeekTheme.buttonPaddingV, leading: PeekTheme.buttonPaddingV, bottom: PeekTheme.buttonPaddingV, trailing: PeekTheme.buttonPaddingV)
        analyzeBtnConfig.baseBackgroundColor = PeekTheme.accent
        analyzeBtnConfig.baseForegroundColor = PeekTheme.bg
        analyzeBtnConfig.cornerStyle = .fixed
        analyzeBtnConfig.background.cornerRadius = PeekTheme.buttonCornerRadius
        analyzeBtnConfig.image = UIImage(systemName: "text.viewfinder")
        analyzeButton.configuration = analyzeBtnConfig
        analyzeButton.addTarget(self, action: #selector(analyzePressed), for: .touchUpInside)
        analyzeButton.translatesAutoresizingMaskIntoConstraints = false
        analyzeButton.isHidden = true
        headerView.addSubview(analyzeButton)

        // Spinner next to analyze button
        analyzeSpinner.translatesAutoresizingMaskIntoConstraints = false
        analyzeSpinner.hidesWhenStopped = true
        headerView.addSubview(analyzeSpinner)

        // Scroll view for content
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.alwaysBounceVertical = false
        scrollView.keyboardDismissMode = .interactive
        scrollView.backgroundColor = PeekTheme.bg
        view.addSubview(scrollView)

        // Content stack view inside scroll view
        contentStackView.axis = .vertical
        contentStackView.spacing = PeekTheme.spacingMD
        contentStackView.alignment = .fill
        contentStackView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(contentStackView)

        // Image preview container (preview + analyze button side by side)
        let imageRow = UIView()
        imageRow.translatesAutoresizingMaskIntoConstraints = false
        imageRow.isHidden = true
        contentStackView.addArrangedSubview(imageRow)

        imagePreviewView.contentMode = .scaleAspectFit
        imagePreviewView.layer.cornerRadius = PeekTheme.cardCornerRadius
        imagePreviewView.layer.masksToBounds = true
        imagePreviewView.backgroundColor = PeekTheme.bgSecondary
        imagePreviewView.translatesAutoresizingMaskIntoConstraints = false
        imageRow.addSubview(imagePreviewView)

        NSLayoutConstraint.activate([
            imageRow.heightAnchor.constraint(lessThanOrEqualToConstant: 200),
            imagePreviewView.topAnchor.constraint(equalTo: imageRow.topAnchor),
            imagePreviewView.leadingAnchor.constraint(equalTo: imageRow.leadingAnchor),
            imagePreviewView.bottomAnchor.constraint(equalTo: imageRow.bottomAnchor),
            imagePreviewView.trailingAnchor.constraint(equalTo: imageRow.trailingAnchor),
        ])

        // Vision results container (hidden by default)
        visionResultsContainer.axis = .vertical
        visionResultsContainer.spacing = PeekTheme.spacingSM
        visionResultsContainer.alignment = .fill
        visionResultsContainer.isHidden = true
        visionResultsContainer.translatesAutoresizingMaskIntoConstraints = false
        contentStackView.addArrangedSubview(visionResultsContainer)

        // OCR text view (editable)
        ocrTextView.font = PeekTheme.caption
        ocrTextView.textColor = PeekTheme.textSecondary
        ocrTextView.backgroundColor = PeekTheme.bgSecondary
        ocrTextView.layer.cornerRadius = PeekTheme.inputCornerRadius
        ocrTextView.layer.borderWidth = 1
        ocrTextView.layer.borderColor = PeekTheme.border.cgColor
        ocrTextView.textContainerInset = UIEdgeInsets(top: 6, left: 4, bottom: 6, right: 4)
        ocrTextView.isScrollEnabled = false  // Let it grow with content
        ocrTextView.isEditable = true
        ocrTextView.delegate = self
        ocrTextView.isHidden = true
        ocrTextView.translatesAutoresizingMaskIntoConstraints = false
        visionResultsContainer.addArrangedSubview(ocrTextView)
        // Constrain to ~4 lines initially, expanded via show more
        let ocrMaxHeight = ocrTextView.heightAnchor.constraint(lessThanOrEqualToConstant: 80)
        ocrMaxHeight.priority = .defaultHigh
        ocrMaxHeight.isActive = true
        ocrTextView.tag = 100  // Tag to find the height constraint later

        // "Show more" button for OCR text
        ocrShowMoreButton.setTitle("Show more", for: .normal)
        ocrShowMoreButton.titleLabel?.font = PeekTheme.micro
        ocrShowMoreButton.setTitleColor(PeekTheme.accent, for: .normal)
        ocrShowMoreButton.contentHorizontalAlignment = .leading
        ocrShowMoreButton.addTarget(self, action: #selector(toggleOcrText), for: .touchUpInside)
        ocrShowMoreButton.isHidden = true
        visionResultsContainer.addArrangedSubview(ocrShowMoreButton)

        // Barcodes label
        barcodesLabel.font = PeekTheme.caption
        barcodesLabel.textColor = PeekTheme.textSecondary
        barcodesLabel.numberOfLines = 0
        barcodesLabel.isHidden = true
        visionResultsContainer.addArrangedSubview(barcodesLabel)

        // Suggested tags section label
        let suggestedLabel = UILabel()
        suggestedLabel.text = "SUGGESTED TAGS"
        suggestedLabel.font = PeekTheme.sectionLabel
        suggestedLabel.textColor = PeekTheme.textMuted
        suggestedLabel.isHidden = true
        suggestedLabel.tag = 99  // Tag to find it later
        visionResultsContainer.addArrangedSubview(suggestedLabel)

        // Suggested tags collection view
        suggestedTagsCollectionView.backgroundColor = .clear
        suggestedTagsCollectionView.delegate = self
        suggestedTagsCollectionView.dataSource = self
        suggestedTagsCollectionView.tag = 3
        suggestedTagsCollectionView.isScrollEnabled = false
        suggestedTagsCollectionView.register(TagCell.self, forCellWithReuseIdentifier: "TagCell")
        suggestedTagsCollectionView.isHidden = true
        visionResultsContainer.addArrangedSubview(suggestedTagsCollectionView)

        // Editable content area — base05 (primary text) to stay visible against share sheet bg
        contentTextView.font = PeekTheme.body
        contentTextView.textColor = PeekTheme.text
        contentTextView.backgroundColor = PeekTheme.bgSecondary
        contentTextView.layer.cornerRadius = PeekTheme.inputCornerRadius
        contentTextView.layer.borderWidth = 1
        contentTextView.layer.borderColor = PeekTheme.border.cgColor
        contentTextView.textContainerInset = UIEdgeInsets(top: 8, left: 4, bottom: 8, right: 4)
        contentTextView.isScrollEnabled = false  // Let it grow with content
        contentTextView.isEditable = true
        contentTextView.delegate = self
        contentTextView.translatesAutoresizingMaskIntoConstraints = false
        contentStackView.addArrangedSubview(contentTextView)
        // Constrain max height so it doesn't grow unbounded
        let contentTextViewMaxHeight = contentTextView.heightAnchor.constraint(lessThanOrEqualToConstant: 120)
        contentTextViewMaxHeight.isActive = true
        // Extra space below content since it's the focal point
        contentStackView.setCustomSpacing(PeekTheme.spacingMD * 3, after: contentTextView)

        // Selected Tags Collection View - self-sizing
        selectedTagsCollectionView.backgroundColor = .clear
        selectedTagsCollectionView.delegate = self
        selectedTagsCollectionView.dataSource = self
        selectedTagsCollectionView.tag = 1
        selectedTagsCollectionView.isScrollEnabled = false
        selectedTagsCollectionView.register(SelectedTagCell.self, forCellWithReuseIdentifier: "SelectedTagCell")
        contentStackView.addArrangedSubview(selectedTagsCollectionView)

        // Input container (text field + add button)
        inputContainerView.translatesAutoresizingMaskIntoConstraints = false
        contentStackView.addArrangedSubview(inputContainerView)
        // Equal spacing above and below the input field
        contentStackView.setCustomSpacing(PeekTheme.spacingMD, after: selectedTagsCollectionView)
        contentStackView.setCustomSpacing(PeekTheme.spacingMD, after: inputContainerView)

        // Text field styled like .new-tag-input
        newTagTextField.placeholder = "Add new tag..."
        newTagTextField.borderStyle = .none
        newTagTextField.autocapitalizationType = .none
        newTagTextField.autocorrectionType = .no
        newTagTextField.font = PeekTheme.input
        newTagTextField.textColor = PeekTheme.text
        newTagTextField.returnKeyType = .done
        newTagTextField.translatesAutoresizingMaskIntoConstraints = false
        newTagTextField.delegate = self
        newTagTextField.addTarget(self, action: #selector(tagTextFieldChanged), for: .editingChanged)
        newTagTextField.backgroundColor = PeekTheme.bgSecondary
        newTagTextField.layer.cornerRadius = PeekTheme.inputCornerRadius
        newTagTextField.layer.borderWidth = 1
        newTagTextField.layer.borderColor = PeekTheme.border.cgColor
        // Add left padding
        newTagTextField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 8, height: 1))
        newTagTextField.leftViewMode = .always
        newTagTextField.attributedPlaceholder = NSAttributedString(
            string: "Add new tag...",
            attributes: [.foregroundColor: PeekTheme.textMuted, .font: PeekTheme.input]
        )
        inputContainerView.addSubview(newTagTextField)

        // Add button — same style as close button
        var btnConfig = UIButton.Configuration.filled()
        btnConfig.contentInsets = NSDirectionalEdgeInsets(top: PeekTheme.buttonPaddingV, leading: PeekTheme.buttonPaddingH, bottom: PeekTheme.buttonPaddingV, trailing: PeekTheme.buttonPaddingH)
        btnConfig.baseBackgroundColor = PeekTheme.accent
        btnConfig.baseForegroundColor = PeekTheme.bg
        btnConfig.cornerStyle = .fixed
        btnConfig.background.cornerRadius = PeekTheme.buttonCornerRadius
        btnConfig.title = "Add"
        btnConfig.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var outgoing = incoming
            outgoing.font = PeekTheme.inputMedium
            return outgoing
        }
        addTagButton.configuration = btnConfig
        addTagButton.addTarget(self, action: #selector(addTagPressed), for: .touchUpInside)
        addTagButton.translatesAutoresizingMaskIntoConstraints = false
        inputContainerView.addSubview(addTagButton)

        // Unused Tags Collection View - self-sizing
        unusedTagsCollectionView.backgroundColor = .clear
        unusedTagsCollectionView.delegate = self
        unusedTagsCollectionView.dataSource = self
        unusedTagsCollectionView.tag = 2
        unusedTagsCollectionView.isScrollEnabled = false
        unusedTagsCollectionView.register(TagCell.self, forCellWithReuseIdentifier: "TagCell")
        contentStackView.addArrangedSubview(unusedTagsCollectionView)

        // Layout constraints — using PeekTheme spacing constants
        NSLayoutConstraint.activate([
            // Header at top
            headerView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: PeekTheme.spacingMD),
            headerView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            headerView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            headerView.heightAnchor.constraint(equalToConstant: 44),

            // Title on the LEFT
            titleLabel.leadingAnchor.constraint(equalTo: headerView.leadingAnchor, constant: PeekTheme.paddingH),
            titleLabel.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),

            // Status label centered between title and buttons
            statusLabel.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: titleLabel.trailingAnchor, constant: PeekTheme.spacingMD),
            statusLabel.trailingAnchor.constraint(lessThanOrEqualTo: analyzeButton.leadingAnchor, constant: -PeekTheme.spacingMD),

            // Analyze button — adjacent to close button, same height
            analyzeButton.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor, constant: -PeekTheme.spacingSM),
            analyzeButton.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            analyzeButton.heightAnchor.constraint(equalTo: closeButton.heightAnchor),

            // Spinner overlays analyze button
            analyzeSpinner.centerXAnchor.constraint(equalTo: analyzeButton.centerXAnchor),
            analyzeSpinner.centerYAnchor.constraint(equalTo: analyzeButton.centerYAnchor),

            // Close button (✕) on the RIGHT
            closeButton.trailingAnchor.constraint(equalTo: headerView.trailingAnchor, constant: -PeekTheme.paddingH),
            closeButton.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),

            // Scroll view below header
            scrollView.topAnchor.constraint(equalTo: headerView.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),

            // Content stack view inside scroll view
            contentStackView.topAnchor.constraint(equalTo: scrollView.topAnchor, constant: PeekTheme.spacingMD * 3),
            contentStackView.leadingAnchor.constraint(equalTo: scrollView.leadingAnchor, constant: PeekTheme.paddingH),
            contentStackView.trailingAnchor.constraint(equalTo: scrollView.trailingAnchor, constant: -PeekTheme.paddingH),
            contentStackView.bottomAnchor.constraint(equalTo: scrollView.bottomAnchor, constant: -PeekTheme.paddingH),
            contentStackView.widthAnchor.constraint(equalTo: scrollView.widthAnchor, constant: -(PeekTheme.paddingH * 2)),

            // Input container internal layout
            inputContainerView.heightAnchor.constraint(equalToConstant: 32),
            newTagTextField.topAnchor.constraint(equalTo: inputContainerView.topAnchor),
            newTagTextField.leadingAnchor.constraint(equalTo: inputContainerView.leadingAnchor),
            newTagTextField.trailingAnchor.constraint(equalTo: addTagButton.leadingAnchor, constant: -PeekTheme.spacingMD),
            newTagTextField.bottomAnchor.constraint(equalTo: inputContainerView.bottomAnchor),
            addTagButton.centerYAnchor.constraint(equalTo: inputContainerView.centerYAnchor),
            addTagButton.trailingAnchor.constraint(equalTo: inputContainerView.trailingAnchor),

            // No minimum heights — self-sizing handles it via intrinsicContentSize
        ])
    }

    @objc func tagTextFieldChanged() {
        tagFilterText = newTagTextField.text?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        updateTagsUI()
    }

    @objc func addTagPressed() {
        guard let text = newTagTextField.text?.trimmingCharacters(in: .whitespaces).lowercased(),
              !text.isEmpty else { return }

        // Support comma-separated tags
        let parts = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        for part in parts where !part.isEmpty {
            selectedTags.insert(part)
        }

        newTagTextField.text = ""
        tagFilterText = ""
        updateTagsUI()
        saveCurrentState()
    }

    func loadSharedContent() {
        guard let extensionItem = extensionContext?.inputItems.first as? NSExtensionItem,
              let itemProviders = extensionItem.attachments else {
            os_log("No extension items or attachments", log: shareLog, type: .error)
            return
        }

        // Log what we received for debugging
        os_log("Received %d item providers", log: shareLog, type: .info, itemProviders.count)
        for (index, provider) in itemProviders.enumerated() {
            os_log("Provider %d: %{public}@", log: shareLog, type: .info, index, provider.registeredTypeIdentifiers.joined(separator: ", "))
        }

        // Capture metadata from NSExtensionItem
        captureMetadata(from: extensionItem)

        // Also log the extension item's content
        if let contentText = extensionItem.attributedContentText?.string {
            os_log("Extension item attributedContentText: %{public}@", log: shareLog, type: .info, contentText)
        }

        // Log all available userInfo for debugging
        if let userInfo = extensionItem.userInfo {
            os_log("Extension item userInfo keys: %{public}@", log: shareLog, type: .info, userInfo.keys.map { String(describing: $0) }.joined(separator: ", "))
        }

        // Search all providers for http/https URLs (not file:// URLs)
        // We need to check all providers because Safari may provide multiple
        for provider in itemProviders {
            // Try loading as URL object first
            if provider.canLoadObject(ofClass: URL.self) {
                os_log("Provider can load URL object, attempting...", log: shareLog, type: .info)
                _ = provider.loadObject(ofClass: URL.self) { [weak self] (url, error) in
                    if let error = error {
                        os_log("Error loading URL object: %{public}@", log: shareLog, type: .error, error.localizedDescription)
                    }
                    if let url = url {
                        os_log("Loaded URL object: %{public}@", log: shareLog, type: .info, url.absoluteString)
                        // Only accept http/https URLs, not file:// URLs
                        if url.scheme == "http" || url.scheme == "https" {
                            // Check if this looks like an image URL
                            let imageExtensions = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff", "svg"]
                            let ext = url.pathExtension.lowercased()
                            if imageExtensions.contains(ext) {
                                // Store for use by image handler instead of treating as page
                                print("[ShareExt] URL looks like image, storing pendingImageUrl: \(url.absoluteString)")
                                DispatchQueue.main.async {
                                    self?.pendingImageUrl = url.absoluteString
                                }
                            } else {
                                DispatchQueue.main.async {
                                    self?.setSharedURL(url.absoluteString)
                                }
                            }
                        } else {
                            os_log("Ignoring non-http URL: %{public}@", log: shareLog, type: .info, url.scheme ?? "nil")
                        }
                    }
                }
            }

            // Try public.url type identifier
            if provider.hasItemConformingToTypeIdentifier("public.url") {
                os_log("Provider has public.url, attempting...", log: shareLog, type: .info)
                provider.loadItem(forTypeIdentifier: "public.url", options: nil) { [weak self] (item, error) in
                    if let error = error {
                        os_log("Error loading public.url: %{public}@", log: shareLog, type: .error, error.localizedDescription)
                    }
                    var urlString: String?

                    if let url = item as? URL {
                        urlString = url.absoluteString
                        os_log("public.url loaded as URL: %{public}@", log: shareLog, type: .info, urlString ?? "")
                    } else if let data = item as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) {
                        urlString = url.absoluteString
                        os_log("public.url loaded as Data->URL: %{public}@", log: shareLog, type: .info, urlString ?? "")
                    } else if let string = item as? String {
                        urlString = string
                        os_log("public.url loaded as String: %{public}@", log: shareLog, type: .info, urlString ?? "")
                    } else {
                        os_log("public.url item type: %{public}@", log: shareLog, type: .info, String(describing: type(of: item)))
                    }

                    // Only accept http/https URLs
                    if let urlString = urlString,
                       (urlString.hasPrefix("http://") || urlString.hasPrefix("https://")) {
                        // Check if this looks like an image URL
                        let imageExtensions = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff", "svg"]
                        let ext = URL(string: urlString)?.pathExtension.lowercased() ?? ""
                        if imageExtensions.contains(ext) {
                            // Store for use by image handler instead of treating as page
                            os_log("URL looks like image, storing for image handler: %{public}@", log: shareLog, type: .info, urlString)
                            DispatchQueue.main.async {
                                self?.pendingImageUrl = urlString
                            }
                        } else {
                            DispatchQueue.main.async {
                                self?.setSharedURL(urlString)
                            }
                        }
                    } else if let urlString = urlString {
                        os_log("Ignoring non-http URL string: %{public}@", log: shareLog, type: .info, urlString)
                    }
                }
            }

            // Try loading as plain text - could be a URL or plain text content
            if provider.hasItemConformingToTypeIdentifier("public.plain-text") {
                os_log("Provider has public.plain-text, attempting...", log: shareLog, type: .info)
                provider.loadItem(forTypeIdentifier: "public.plain-text", options: nil) { [weak self] (item, error) in
                    if let string = item as? String {
                        os_log("public.plain-text loaded: %{public}@", log: shareLog, type: .info, string)
                        // Check if it's a URL
                        if string.hasPrefix("http://") || string.hasPrefix("https://") {
                            DispatchQueue.main.async {
                                self?.setSharedURL(string)
                            }
                        } else {
                            // It's plain text content
                            DispatchQueue.main.async {
                                self?.setSharedText(string)
                            }
                        }
                    }
                }
            }

            // Handle image sharing
            if provider.hasItemConformingToTypeIdentifier("public.image") {
                os_log("Provider has public.image", log: shareLog, type: .info)
                let suggestedName = provider.suggestedName
                if let suggestedName = suggestedName {
                    os_log("Image suggested name: %{public}@", log: shareLog, type: .info, suggestedName)
                }

                provider.loadItem(forTypeIdentifier: "public.image", options: nil) { [weak self] (item, error) in
                    if let error = error {
                        os_log("Error loading image: %{public}@", log: shareLog, type: .error, error.localizedDescription)
                        return
                    }

                    var imageData: Data?
                    var mimeType = "image/jpeg"
                    var sourceUrl: String?
                    var filename: String? = suggestedName

                    // Handle different item types
                    if let url = item as? URL {
                        // Image from file URL
                        os_log("Image URL: %{public}@", log: shareLog, type: .info, url.absoluteString)
                        if url.scheme == "file" {
                            imageData = try? Data(contentsOf: url)
                            // Get filename from path if not already set
                            if filename == nil || filename?.isEmpty == true {
                                filename = url.lastPathComponent
                            }
                            // Determine MIME type from extension
                            let ext = url.pathExtension.lowercased()
                            switch ext {
                            case "png":
                                mimeType = "image/png"
                            case "gif":
                                mimeType = "image/gif"
                            case "webp":
                                mimeType = "image/webp"
                            case "heic", "heif":
                                mimeType = "image/heic"
                            default:
                                mimeType = "image/jpeg"
                            }
                        } else if url.scheme == "http" || url.scheme == "https" {
                            // Web image - store the source URL
                            sourceUrl = url.absoluteString
                            // Get filename from URL path if not already set
                            if filename == nil || filename?.isEmpty == true {
                                filename = url.lastPathComponent
                            }
                        }
                    } else if let image = item as? UIImage {
                        // UIImage directly
                        imageData = image.jpegData(compressionQuality: 0.9)
                    } else if let data = item as? Data {
                        // Raw data
                        imageData = data
                    }

                    // If we got a web URL but no data, try to fetch it
                    if imageData == nil, let sourceUrl = sourceUrl, let _ = URL(string: sourceUrl) {
                        os_log("Fetching image from URL: %{public}@", log: shareLog, type: .info, sourceUrl)
                        // Note: In a real implementation, you might want to fetch asynchronously
                        // For now, we'll just store the URL as metadata
                    }

                    guard let data = imageData else {
                        os_log("Could not extract image data", log: shareLog, type: .error)
                        return
                    }

                    // Small delay to allow URL handlers to set pendingImageUrl first
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        // Use pendingImageUrl if we don't have sourceUrl or filename
                        var finalSourceUrl = sourceUrl
                        var finalFilename = filename

                        print("[ShareExt] Image handler - initial sourceUrl: \(sourceUrl ?? "nil"), filename: \(filename ?? "nil")")
                        print("[ShareExt] Image handler - pendingImageUrl: \(self?.pendingImageUrl ?? "nil")")

                        if let pendingUrl = self?.pendingImageUrl {
                            if finalSourceUrl == nil {
                                finalSourceUrl = pendingUrl
                                print("[ShareExt] Using pendingImageUrl for sourceUrl")
                            }
                            if finalFilename == nil || finalFilename?.isEmpty == true {
                                finalFilename = URL(string: pendingUrl)?.lastPathComponent
                                print("[ShareExt] Extracted filename from pendingImageUrl: \(finalFilename ?? "nil")")
                            }
                        }

                        print("[ShareExt] Calling setSharedImage with sourceUrl: \(finalSourceUrl ?? "nil"), filename: \(finalFilename ?? "nil")")
                        self?.setSharedImage(data, mimeType: mimeType, sourceUrl: finalSourceUrl, filename: finalFilename)
                    }
                }
            }
        }

        // Also check attributedContentText for URL
        if let attributedText = extensionItem.attributedContentText,
           let urlString = attributedText.string.components(separatedBy: .whitespaces).first(where: { $0.hasPrefix("http://") || $0.hasPrefix("https://") }) {
            os_log("Found URL in attributedContentText: %{public}@", log: shareLog, type: .info, urlString)
            setSharedURL(urlString)
        }

        // Check userInfo for URL - Safari sometimes puts URL in userInfo
        if let userInfo = extensionItem.userInfo {
            for (key, value) in userInfo {
                os_log("userInfo[%{public}@] = %{public}@", log: shareLog, type: .info, String(describing: key), String(describing: value))
                if let urlString = value as? String,
                   (urlString.hasPrefix("http://") || urlString.hasPrefix("https://")) {
                    os_log("Found URL in userInfo: %{public}@", log: shareLog, type: .info, urlString)
                    setSharedURL(urlString)
                } else if let url = value as? URL,
                          (url.scheme == "http" || url.scheme == "https") {
                    os_log("Found URL object in userInfo: %{public}@", log: shareLog, type: .info, url.absoluteString)
                    setSharedURL(url.absoluteString)
                }
            }
        }
    }

    private func setSharedURL(_ urlString: String) {
        guard sharedURL == nil && sharedText == nil && sharedImageData == nil else {
            os_log("Content already set, ignoring URL: %{public}@", log: shareLog, type: .info, urlString)
            return
        }
        let normalized = urlString.normalizeURL()
        os_log("Setting shared URL: %{public}@ (normalized: %{public}@)", log: shareLog, type: .info, urlString, normalized)
        sharedURL = normalized
        sharedItemType = .page
        contentTextView.text = urlString
        checkIfURLExists()
    }

    private func setSharedText(_ text: String) {
        guard sharedURL == nil && sharedText == nil && sharedImageData == nil else {
            os_log("Content already set, ignoring text", log: shareLog, type: .info)
            return
        }
        os_log("Setting shared text: %{public}@", log: shareLog, type: .info, String(text.prefix(50)))
        sharedText = text
        sharedItemType = .text
        contentTextView.text = text

        // Parse hashtags from text and add them as tags
        let hashtags = parseHashtags(from: text)
        for tag in hashtags {
            selectedTags.insert(tag)
        }

        // Load tags
        loadTags()

        // Auto-save
        saveCurrentState()

        // Show status
        showStatus("\u{2713} Saved", color: .systemGreen)
    }

    private func setSharedImage(_ imageData: Data, mimeType: String, sourceUrl: String?, filename: String?) {
        guard sharedURL == nil && sharedText == nil && sharedImageData == nil else {
            print("[ShareExt] Content already set, ignoring image")
            return
        }
        print("[ShareExt] Setting shared image: \(imageData.count) bytes, type: \(mimeType)")

        sharedImageData = imageData
        sharedImageMimeType = mimeType
        sharedImageSourceUrl = sourceUrl
        sharedItemType = .image

        // Get image dimensions and show preview using CGImageSource
        // CRITICAL: Do NOT use UIImage(data:) here — it fully decompresses HEIC
        // images into a bitmap (~195MB for 48MP), blowing the 220MB extension limit.
        if let source = CGImageSourceCreateWithData(imageData as CFData, nil),
           let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let pixelWidth = properties[kCGImagePropertyPixelWidth] as? Int,
           let pixelHeight = properties[kCGImagePropertyPixelHeight] as? Int {
            sharedMetadata["width"] = pixelWidth
            sharedMetadata["height"] = pixelHeight

            // Create a small thumbnail for preview (decodes only needed pixels)
            let thumbOpts: [CFString: Any] = [
                kCGImageSourceThumbnailMaxPixelSize: 400,
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true
            ]
            if let cgThumb = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOpts as CFDictionary) {
                imagePreviewView.image = UIImage(cgImage: cgThumb)
            }
            imagePreviewView.superview?.isHidden = false  // imageRow
            analyzeButton.isHidden = false
        }

        // Generate title from filename, or try to extract from selectedText
        var effectiveFilename = filename
        if effectiveFilename == nil || effectiveFilename?.isEmpty == true {
            // Try to extract filename from selectedText (Safari puts filename there)
            if let selectedText = sharedMetadata["selectedText"] as? String {
                // Look for a filename pattern (word ending in image extension)
                let imageExtensions = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff", "svg"]
                let words = selectedText.components(separatedBy: .whitespaces)
                for word in words {
                    let ext = (word as NSString).pathExtension.lowercased()
                    if imageExtensions.contains(ext) {
                        effectiveFilename = word
                        break
                    }
                }
            }
        }

        let title = titleFromFilename(effectiveFilename)
        print("[ShareExt] Generated title: \(title ?? "nil") from filename: \(effectiveFilename ?? "nil")")
        if let title = title {
            sharedMetadata["title"] = title
            contentTextView.text = title
            print("[ShareExt] Set title in metadata and label: \(title)")
        } else if let sourceUrl = sourceUrl {
            // Fallback: try to get title from source URL
            if let urlTitle = titleFromFilename(URL(string: sourceUrl)?.lastPathComponent) {
                sharedMetadata["title"] = urlTitle
                contentTextView.text = urlTitle
            } else {
                contentTextView.text = "Image from: \(sourceUrl)"
            }
        } else {
            let sizeKB = imageData.count / 1024
            contentTextView.text = "Image (\(sizeKB) KB)"
        }

        // Store source URL in metadata if present
        if let sourceUrl = sourceUrl {
            sharedMetadata["sourceUrl"] = sourceUrl
        }

        // Load tags
        loadTags()

        // Auto-save
        saveCurrentState()

        // Show status
        showStatus("\u{2713} Saved", color: .systemGreen)
    }

    /// Convert a filename to a readable title
    private func titleFromFilename(_ filename: String?) -> String? {
        guard let filename = filename, !filename.isEmpty else { return nil }

        // Remove file extension
        var name = (filename as NSString).deletingPathExtension

        // Skip if it looks like a UUID or random string (all hex chars and dashes, or very long without spaces)
        let hexPattern = "^[0-9a-fA-F-]+$"
        if let regex = try? NSRegularExpression(pattern: hexPattern),
           regex.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil,
           name.count > 20 {
            return nil
        }

        // Skip if it's just numbers (like timestamps)
        if name.allSatisfy({ $0.isNumber || $0 == "-" || $0 == "_" }) && name.count > 8 {
            return nil
        }

        // Replace common separators with spaces
        name = name.replacingOccurrences(of: "_", with: " ")
        name = name.replacingOccurrences(of: "-", with: " ")
        name = name.replacingOccurrences(of: ".", with: " ")

        // Collapse multiple spaces
        while name.contains("  ") {
            name = name.replacingOccurrences(of: "  ", with: " ")
        }

        // Trim whitespace
        name = name.trimmingCharacters(in: .whitespaces)

        // Skip if too short or empty
        if name.count < 2 {
            return nil
        }

        // Capitalize first letter of each word
        name = name.capitalized

        return name
    }

    /// Parse hashtags from text content
    private func parseHashtags(from text: String) -> [String] {
        let pattern = "#(\\w+)"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return []
        }
        let range = NSRange(text.startIndex..., in: text)
        let matches = regex.matches(in: text, options: [], range: range)

        var tags: [String] = []
        for match in matches {
            if let tagRange = Range(match.range(at: 1), in: text) {
                tags.append(String(text[tagRange]).lowercased())
            }
        }
        return tags
    }

    /// Capture metadata from NSExtensionItem (title, selected text, source app, etc.)
    private func captureMetadata(from extensionItem: NSExtensionItem) {
        var metadata: [String: Any] = [:]

        // Capture page title from attributedTitle (Safari provides this)
        if let title = extensionItem.attributedTitle?.string, !title.isEmpty {
            metadata["title"] = title
            os_log("Captured title: %{public}@", log: shareLog, type: .info, title)
        }

        // Capture selected text or description from attributedContentText
        if let contentText = extensionItem.attributedContentText?.string, !contentText.isEmpty {
            // Don't store if it's just the URL we're already saving
            if contentText != sharedURL {
                metadata["selectedText"] = contentText
                os_log("Captured selectedText: %{public}@", log: shareLog, type: .info, String(contentText.prefix(100)))
            }
        }

        // Capture source app bundle identifier from userInfo
        if let userInfo = extensionItem.userInfo {
            // Try common keys for source app
            if let sourceApp = userInfo["NSExtensionItemSourceApplicationKey"] as? String {
                metadata["sourceApp"] = sourceApp
                os_log("Captured sourceApp: %{public}@", log: shareLog, type: .info, sourceApp)
            } else if let sourceApp = userInfo[NSExtensionItemAttributedTitleKey] as? String {
                // Sometimes the app name is here
                if metadata["title"] == nil {
                    metadata["title"] = sourceApp
                }
            }

            // Check for any URL-related keys that might have title info
            for (key, value) in userInfo {
                let keyStr = String(describing: key)
                if keyStr.lowercased().contains("title"), let titleValue = value as? String, !titleValue.isEmpty {
                    if metadata["title"] == nil {
                        metadata["title"] = titleValue
                        os_log("Captured title from userInfo[%{public}@]: %{public}@", log: shareLog, type: .info, keyStr, titleValue)
                    }
                }
            }
        }

        // Store timestamp of share action
        metadata["sharedAt"] = ISO8601DateFormatter.shared.string(from: Date())

        self.sharedMetadata = metadata
        os_log("Metadata captured: %{public}@", log: shareLog, type: .info, metadata.keys.joined(separator: ", "))
    }

    func checkIfURLExists() {
        guard let url = sharedURL else { return }

        let existing = PeekCoreManager.shared.findExistingUrl(url)
        if let existing = existing {
            existingSavedItem = existing
            selectedTags = Set(existing.tags)
        }
        // Reload tags with domain boost now that we know the URL
        loadTags()

        // Auto-save immediately so URL is saved even if user doesn't select any tags
        saveCurrentState()

        // Show status indicator
        if existing != nil {
            showStatus("\u{2713} Saved", color: .secondaryLabel)
        } else {
            showStatus("\u{2713} Saved", color: .systemGreen)
        }
    }

    private func showStatus(_ text: String, color: UIColor, autoDismissAfter: TimeInterval? = nil) {
        statusLabel.text = text
        // Map system colors to Peek theme colors
        if color == .systemGreen {
            statusLabel.textColor = PeekTheme.success
        } else if color == .systemRed {
            statusLabel.textColor = PeekTheme.danger
        } else if color == .secondaryLabel {
            statusLabel.textColor = PeekTheme.textSecondary
        } else {
            statusLabel.textColor = color
        }

        UIView.animate(withDuration: 0.15) {
            self.statusLabel.alpha = 1
        }

        if let delay = autoDismissAfter {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self else { return }
                // Only revert if still showing the same text
                guard self.statusLabel.text == text else { return }
                self.showStatus("\u{2713} Saved", color: .systemGreen)
            }
        }
    }

    func loadTags() {
        let domain = sharedURL?.extractDomain()
        availableTags = PeekCoreManager.shared.loadTagsWithDomainBoost(forDomain: domain)
        updateTagsUI()
    }

    func updateTagsUI() {
        // Reload both collection views
        selectedTagsCollectionView.reloadData()
        unusedTagsCollectionView.reloadData()

        // Force layout update for self-sizing collection views
        DispatchQueue.main.async { [weak self] in
            self?.selectedTagsCollectionView.invalidateIntrinsicContentSize()
            self?.unusedTagsCollectionView.invalidateIntrinsicContentSize()
            self?.view.layoutIfNeeded()
            self?.updatePreferredContentSize()
        }
    }

    func getUnusedTags() -> [TagStats] {
        return availableTags.filter { tag in
            !selectedTags.contains(tag.name) &&
            (tagFilterText.isEmpty || tag.name.lowercased().contains(tagFilterText))
        }
    }

    func getSortedSelectedTags() -> [String] {
        return Array(selectedTags).sorted()
    }

    /// Save the current state of selectedTags to the database (called instantly on tag changes)
    func saveCurrentState() {
        let finalTags = Array(selectedTags).sorted()

        // Include edited content from the text view in metadata
        let editedContent = contentTextView.text?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let content = editedContent, !content.isEmpty {
            sharedMetadata["content"] = content
        }

        // Include edited OCR text if present
        let editedOcr = ocrTextView.text?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let ocr = editedOcr, !ocr.isEmpty {
            sharedMetadata["ocrText"] = ocr
        }

        let metadata = sharedMetadata.isEmpty ? nil : sharedMetadata
        print("[ShareExt] saveCurrentState - sharedMetadata: \(sharedMetadata)")

        switch sharedItemType {
        case .page:
            guard let url = sharedURL, !url.isEmpty else { return }

            // PeekStore handles upsert internally (finds existing by URL, updates if exists)
            PeekCoreManager.shared.saveUrl(
                url: url,
                tags: finalTags,
                metadata: metadata
            ) { }

            // Set existingSavedItem synchronously after the DB write completes
            // (saveUrl's DB write is synchronous; only the webhook push is async).
            if existingSavedItem == nil {
                existingSavedItem = PeekCoreManager.shared.findExistingUrl(url)
            }

        case .text:
            // Use edited text from the text view, falling back to original shared text
            let textContent = editedContent ?? sharedText ?? ""
            guard !textContent.isEmpty else { return }

            PeekCoreManager.shared.saveText(
                content: textContent,
                tags: finalTags,
                metadata: metadata
            ) { }

        case .tagset:
            // Tagsets are not supported in Share Extension
            break

        case .image:
            guard let imageData = sharedImageData, let mimeType = sharedImageMimeType else { return }

            PeekCoreManager.shared.debugLog("saveCurrentState .image: savedImageId=\(savedImageId ?? "nil"), isSavingImage=\(isSavingImage)")

            // If image already saved, update tags and metadata (includes _vision data)
            if let existingImageId = savedImageId {
                PeekCoreManager.shared.debugLog("saveCurrentState: taking UPDATE path for \(existingImageId)")
                PeekCoreManager.shared.updateImageTagsAndMetadata(
                    imageId: existingImageId,
                    tags: finalTags,
                    metadata: metadata ?? [:]
                ) { }
                return
            }

            // Prevent concurrent saves from creating duplicate images
            guard !isSavingImage else {
                PeekCoreManager.shared.debugLog("saveCurrentState: BLOCKED by isSavingImage")
                return
            }
            isSavingImage = true
            PeekCoreManager.shared.debugLog("saveCurrentState: taking CREATE path")

            // Get image dimensions from sharedMetadata (set by CGImageSource in setSharedImage)
            let width = sharedMetadata["width"] as? Int
            let height = sharedMetadata["height"] as? Int

            // Generate thumbnail
            let thumbnail = PeekCoreManager.shared.generateThumbnail(from: imageData)

            PeekCoreManager.shared.saveImage(
                imageData: imageData,
                mimeType: mimeType,
                width: width,
                height: height,
                thumbnail: thumbnail,
                sourceUrl: sharedImageSourceUrl,
                tags: finalTags,
                metadata: metadata
            ) { [weak self] imageId in
                guard let self = self else { return }
                PeekCoreManager.shared.debugLog("saveImage completion: imageId=\(imageId ?? "nil")")
                if let imageId = imageId {
                    self.savedImageId = imageId
                    // If this was a dedup (image already existed), load and show existing OCR content
                    if let existingContent = PeekCoreManager.shared.getItemContent(itemId: imageId),
                       !existingContent.isEmpty {
                        DispatchQueue.main.async {
                            self.ocrTextView.text = existingContent
                            self.ocrTextView.isHidden = false
                            self.visionResultsContainer.isHidden = false
                            self.showStatus("\u{2713} Saved", color: .secondaryLabel)
                        }
                    }
                }
                self.isSavingImage = false
            }
        }
    }

    @objc func analyzePressed() {
        guard let imageData = sharedImageData, !isAnalyzing else { return }
        isAnalyzing = true
        analyzeButton.isEnabled = false
        analyzeSpinner.startAnimating()

        VisionAnalyzer.analyze(imageData: imageData) { [weak self] result in
            guard let self = self else { return }
            self.isAnalyzing = false
            self.analyzeSpinner.stopAnimating()
            self.analyzeButton.isEnabled = true

            guard let result = result else {
                os_log("Vision: Analysis returned nil", log: shareLog, type: .error)
                #if targetEnvironment(simulator)
                self.showStatus("Requires device", color: .systemOrange)
                #else
                self.showStatus("Analysis failed", color: .systemRed)
                #endif
                return
            }
            os_log("Vision: OCR=%{public}@, barcodes=%d, entities: people=%d places=%d orgs=%d",
                   log: shareLog, type: .info,
                   result.ocrText != nil ? "yes" : "no",
                   result.barcodes.count,
                   result.entities.people.count,
                   result.entities.places.count,
                   result.entities.organizations.count)

            self.visionResult = result
            self.displayVisionResults(result)

            // Merge _vision into metadata
            let visionMeta = result.toMetadata()
            if !visionMeta.isEmpty {
                self.sharedMetadata["_vision"] = visionMeta
            }

            // Add suggested entity tags
            let entityTags = result.entities.allTags()
            if !entityTags.isEmpty {
                self.suggestedTags = entityTags.filter { !self.selectedTags.contains($0) }
            }

            // Update suggested tags UI
            if !self.suggestedTags.isEmpty {
                // Show the "SUGGESTED TAGS" label
                for subview in self.visionResultsContainer.arrangedSubviews {
                    if subview.tag == 99 {
                        subview.isHidden = false
                    }
                }
                self.suggestedTagsCollectionView.isHidden = false
                self.suggestedTagsCollectionView.reloadData()
                DispatchQueue.main.async {
                    self.suggestedTagsCollectionView.invalidateIntrinsicContentSize()
                }
            }

            // Save vision metadata + OCR text to the item
            PeekCoreManager.shared.debugLog("analyzePressed completion: savedImageId=\(self.savedImageId ?? "nil"), _vision in metadata=\(self.sharedMetadata["_vision"] != nil)")
            if let imageId = self.savedImageId {
                let metadata = self.sharedMetadata.isEmpty ? [:] : self.sharedMetadata
                PeekCoreManager.shared.updateImageTagsAndMetadata(
                    imageId: imageId,
                    tags: Array(self.selectedTags).sorted(),
                    metadata: metadata
                ) { }
                // Save OCR text as item content so main app can display it
                if let ocrText = result.ocrText, !ocrText.isEmpty {
                    PeekCoreManager.shared.updateItemContent(itemId: imageId, content: ocrText)
                }
            }
            // If savedImageId is nil, _vision is already in sharedMetadata and will be
            // included when the image is saved via saveCurrentState() (e.g., on close).
            // Do NOT call saveCurrentState() here — it would create a duplicate image.
            self.showStatus("\u{2713} Analyzed", color: .systemGreen, autoDismissAfter: 2.0)

            self.view.layoutIfNeeded()
            self.updatePreferredContentSize()
        }
    }

    private func displayVisionResults(_ result: VisionAnalysisResult) {
        visionResultsContainer.isHidden = false

        // Show OCR text
        if let text = result.ocrText, !text.isEmpty {
            ocrTextView.text = text
            ocrTextView.isHidden = false
            // Show "show more" if text is long
            let lineCount = text.components(separatedBy: "\n").count
            ocrShowMoreButton.isHidden = lineCount <= 4
        }

        // Show barcodes
        if !result.barcodes.isEmpty {
            let barcodeText = result.barcodes.map { "Barcode: \($0)" }.joined(separator: "\n")
            barcodesLabel.text = barcodeText
            barcodesLabel.isHidden = false
        }
    }

    @objc func toggleOcrText() {
        isOcrExpanded.toggle()
        // Find the max height constraint (tag 100) and toggle it
        if let maxConstraint = ocrTextView.constraints.first(where: { $0.firstAttribute == .height && $0.relation == .lessThanOrEqual }) {
            maxConstraint.isActive = !isOcrExpanded
        }
        ocrTextView.isScrollEnabled = isOcrExpanded  // Scroll when expanded
        if isOcrExpanded {
            ocrShowMoreButton.setTitle("Show less", for: .normal)
            // Set a taller max when expanded
            let expandedHeight = ocrTextView.heightAnchor.constraint(lessThanOrEqualToConstant: 300)
            expandedHeight.priority = .defaultHigh
            expandedHeight.isActive = true
        } else {
            ocrTextView.isScrollEnabled = false
            ocrShowMoreButton.setTitle("Show more", for: .normal)
            // Re-enable the compact constraint
            if let maxConstraint = ocrTextView.constraints.first(where: { $0.firstAttribute == .height && $0.relation == .lessThanOrEqual }) {
                maxConstraint.isActive = true
            }
        }
        view.layoutIfNeeded()
        updatePreferredContentSize()
    }

    @objc func closePressed() {
        // Commit any tag text the user typed but didn't explicitly "Add"
        addTagPressed()
        saveCurrentState()
        // Checkpoint WAL so main app sees our writes immediately
        PeekCoreManager.shared.checkpoint()
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    func showAlert(_ message: String) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}

// MARK: - UICollectionView
extension ShareViewController: UICollectionViewDelegate, UICollectionViewDataSource {
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        if collectionView.tag == 1 {
            // Selected tags
            return getSortedSelectedTags().count
        } else if collectionView.tag == 3 {
            // Suggested tags from vision analysis
            return suggestedTags.count
        } else {
            // Unused tags
            return getUnusedTags().count
        }
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        if collectionView.tag == 1 {
            // Selected tags - with remove button
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "SelectedTagCell", for: indexPath) as! SelectedTagCell
            let tagName = getSortedSelectedTags()[indexPath.item]
            cell.configure(with: tagName) { [weak self] in
                self?.selectedTags.remove(tagName)
                self?.updateTagsUI()
                self?.saveCurrentState()
            }
            return cell
        } else if collectionView.tag == 3 {
            // Suggested tags from vision
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "TagCell", for: indexPath) as! TagCell
            let tagName = suggestedTags[indexPath.item]
            cell.configure(with: tagName, isSelected: false)
            return cell
        } else {
            // Unused tags
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "TagCell", for: indexPath) as! TagCell
            let tag = getUnusedTags()[indexPath.item]
            cell.configure(with: tag.name, isSelected: false)
            return cell
        }
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        if collectionView.tag == 1 {
            // Tapping selected tag removes it
            let tagName = getSortedSelectedTags()[indexPath.item]
            selectedTags.remove(tagName)
        } else if collectionView.tag == 3 {
            // Tapping suggested tag adds it and removes from suggestions
            let tagName = suggestedTags[indexPath.item]
            selectedTags.insert(tagName)
            suggestedTags.removeAll { $0 == tagName }
            suggestedTagsCollectionView.reloadData()
            DispatchQueue.main.async { [weak self] in
                self?.suggestedTagsCollectionView.invalidateIntrinsicContentSize()
            }
        } else {
            // Tapping unused tag adds it
            let tag = getUnusedTags()[indexPath.item]
            selectedTags.insert(tag.name)
            tagFilterText = ""
            newTagTextField.text = ""
        }
        updateTagsUI()
        saveCurrentState()
    }
}

// MARK: - UITextFieldDelegate
extension ShareViewController: UITextFieldDelegate {
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        // Add any pending tag text and dismiss the share UI
        closePressed()
        return true
    }
}

// MARK: - UITextViewDelegate methods
extension ShareViewController {
    func textViewDidChange(_ textView: UITextView) {
        // Resize the text view and update layout
        view.layoutIfNeeded()
        updatePreferredContentSize()
    }

    func textViewDidEndEditing(_ textView: UITextView) {
        // Auto-save when user finishes editing
        saveCurrentState()
    }
}

// MARK: - UIGestureRecognizerDelegate
extension ShareViewController: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // Don't intercept touches on interactive elements
        let touchedView = touch.view
        if touchedView is UIButton || touchedView is UITextField || touchedView is UITextView || touchedView is UICollectionViewCell {
            return false
        }
        // Check if touch is inside a collection view cell
        if let _ = touchedView?.superview as? UICollectionViewCell {
            return false
        }
        return true
    }
}

// MARK: - TagCell
/// Styled to match .available-tag in home.css:
/// padding: 3px 8px, bg: base01, border: 1px base02, radius: 10px, font: 11px
class TagCell: UICollectionViewCell {
    let label = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)

        label.font = PeekTheme.caption
        label.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(label)

        contentView.layer.cornerRadius = PeekTheme.tagCornerRadius
        contentView.layer.borderWidth = 1

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: contentView.topAnchor, constant: PeekTheme.availableTagPaddingV),
            label.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: PeekTheme.availableTagPaddingH),
            label.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -PeekTheme.availableTagPaddingH),
            label.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -PeekTheme.availableTagPaddingV)
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(with text: String, isSelected: Bool) {
        label.text = text

        if isSelected {
            // Matches .tag-chip.selected: color-mix(blue 20%, bg) with blue border
            contentView.backgroundColor = PeekTheme.selectedTagBg
            contentView.layer.borderColor = PeekTheme.selectedTagBorder.cgColor
            label.textColor = PeekTheme.text
        } else {
            // Matches .available-tag: bg base01, border base02
            contentView.backgroundColor = PeekTheme.bgSecondary
            contentView.layer.borderColor = PeekTheme.border.cgColor
            label.textColor = PeekTheme.text
        }
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        // Update border colors when dark/light mode changes (cgColor is not dynamic)
        if traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) {
            let isSelected = contentView.backgroundColor != PeekTheme.bgSecondary
            if isSelected {
                contentView.layer.borderColor = PeekTheme.selectedTagBorder.cgColor
            } else {
                contentView.layer.borderColor = PeekTheme.border.cgColor
            }
        }
    }
}

// MARK: - SelectedTagCell (with remove button)
/// Styled to match .current-tag in home.css:
/// padding: 2px 7px, bg: color-mix(blue 20%, base01), border: 1px color-mix(blue 30%, transparent), radius: 10px
class SelectedTagCell: UICollectionViewCell {
    let label = UILabel()
    let removeButton = UIButton(type: .system)
    var onRemove: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)

        label.font = PeekTheme.caption
        label.textColor = PeekTheme.text
        label.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(label)

        removeButton.setTitle("\u{00D7}", for: .normal)  // multiplication sign
        removeButton.titleLabel?.font = PeekTheme.body
        removeButton.setTitleColor(PeekTheme.textSecondary, for: .normal)
        removeButton.translatesAutoresizingMaskIntoConstraints = false
        removeButton.addTarget(self, action: #selector(removeTapped), for: .touchUpInside)
        contentView.addSubview(removeButton)

        // Matches .current-tag styling
        contentView.backgroundColor = PeekTheme.selectedTagBg
        contentView.layer.cornerRadius = PeekTheme.tagCornerRadius
        contentView.layer.borderWidth = 1
        contentView.layer.borderColor = PeekTheme.selectedTagBorder.cgColor

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: contentView.topAnchor, constant: PeekTheme.currentTagPaddingV),
            label.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: PeekTheme.currentTagPaddingH),
            label.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -PeekTheme.currentTagPaddingV),

            removeButton.leadingAnchor.constraint(equalTo: label.trailingAnchor, constant: PeekTheme.spacingSM),
            removeButton.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -PeekTheme.spacingXS),
            removeButton.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            removeButton.widthAnchor.constraint(equalToConstant: 16)
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(with text: String, onRemove: @escaping () -> Void) {
        label.text = text
        self.onRemove = onRemove
    }

    @objc func removeTapped() {
        onRemove?()
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) {
            contentView.layer.borderColor = PeekTheme.selectedTagBorder.cgColor
        }
    }
}

// MARK: - LeftAlignedFlowLayout
class LeftAlignedFlowLayout: UICollectionViewFlowLayout {
    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        guard let attributes = super.layoutAttributesForElements(in: rect) else { return nil }

        var leftMargin: CGFloat = sectionInset.left
        var maxY: CGFloat = -1.0

        return attributes.map { attr in
            let newAttr = attr.copy() as! UICollectionViewLayoutAttributes

            if newAttr.frame.origin.y >= maxY {
                leftMargin = sectionInset.left
            }

            newAttr.frame.origin.x = leftMargin
            leftMargin += newAttr.frame.width + minimumInteritemSpacing
            maxY = max(newAttr.frame.maxY, maxY)

            return newAttr
        }
    }
}

// MARK: - Self-Sizing Collection View
class SelfSizingCollectionView: UICollectionView {
    override var contentSize: CGSize {
        didSet {
            if oldValue != contentSize {
                invalidateIntrinsicContentSize()
            }
        }
    }

    override var intrinsicContentSize: CGSize {
        let size = collectionViewLayout.collectionViewContentSize
        return CGSize(width: UIView.noIntrinsicMetric, height: size.height)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != intrinsicContentSize {
            invalidateIntrinsicContentSize()
        }
    }
}
