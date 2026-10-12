// Asks a drag's promised types for their data while the drag is in flight, read-only.
// Every type on the drag pasteboard is requested at pasteboard level and per item, on
// every change and then every 0.25 s for 5 s after it (a lazy provider may answer late).
// Usage: swift drag-pasteboard-wildcard.swift [seconds]   (default 600)
// Appends to /tmp/peek-space-drop-wildcard.log; exits after the first drag that changes
// the pasteboard has been probed.
import AppKit

let seconds = Double(CommandLine.arguments.dropFirst().first ?? "600") ?? 600
let logPath = "/tmp/peek-space-drop-wildcard.log"
if !FileManager.default.fileExists(atPath: logPath) {
  FileManager.default.createFile(atPath: logPath, contents: nil)
}
let handle = FileHandle(forWritingAtPath: logPath)!
handle.seekToEndOfFile()

func log(_ s: String) {
  let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(s)\n"
  handle.write(line.data(using: .utf8)!)
  FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

func describe(_ d: Data) -> String {
  let hex = d.prefix(48).map { String(format: "%02x", $0) }.joined()
  var text = ""
  for enc in [String.Encoding.utf8, .utf16, .utf16LittleEndian] {
    if let s = String(data: d, encoding: enc), !s.isEmpty {
      text = " \(enc)=\(String(s.prefix(200)).replacingOccurrences(of: "\n", with: "\\n"))"
      break
    }
  }
  var plist = ""
  if let p = try? PropertyListSerialization.propertyList(from: d, format: nil) {
    plist = " plist=\(String(String(describing: p).prefix(200)))"
  }
  return "<\(d.count) bytes> hex=\(hex)\(text)\(plist)"
}

let pb = NSPasteboard(name: .drag)

func probe(_ why: String) {
  let types = pb.types ?? []
  log("\(why) changeCount=\(pb.changeCount) types=\(types.map { $0.rawValue })")
  for t in types {
    if let d = pb.data(forType: t) {
      log("  pb \(t.rawValue) data=\(describe(d))")
    } else if let p = pb.propertyList(forType: t) {
      log("  pb \(t.rawValue) plist=\(String(String(describing: p).prefix(200)))")
    } else {
      log("  pb \(t.rawValue) nil")
    }
  }
  for (i, item) in (pb.pasteboardItems ?? []).enumerated() {
    for t in item.types {
      if let d = item.data(forType: t) {
        log("  item \(i) \(t.rawValue) data=\(describe(d))")
      } else if let s = item.string(forType: t) {
        log("  item \(i) \(t.rawValue) string=\(String(s.prefix(200)))")
      } else {
        log("  item \(i) \(t.rawValue) nil")
      }
    }
  }
  if let urls = pb.readObjects(forClasses: [NSURL.self], options: nil) as? [URL] {
    log("  readObjects NSURL=\(urls.map { $0.absoluteString })")
  }
}

probe("start")
var last = pb.changeCount
let deadline = Date().addingTimeInterval(seconds)
while Date() < deadline {
  if pb.changeCount != last {
    last = pb.changeCount
    probe("changed")
    for n in 1...20 {
      Thread.sleep(forTimeInterval: 0.25)
      probe("repeat \(n)")
    }
    log("done")
    exit(0)
  }
  Thread.sleep(forTimeInterval: 0.02)
}
log("timeout, no drag seen")
