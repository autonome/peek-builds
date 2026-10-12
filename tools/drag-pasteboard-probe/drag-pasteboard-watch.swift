// Records what an OS drag carries while it is in flight, read-only.
// Usage: swift drag-pasteboard-watch.swift [seconds]   (default 90)
// Appends to /tmp/peek-space-drop-pasteboard.log.
import AppKit

let seconds = Double(CommandLine.arguments.dropFirst().first ?? "90") ?? 90
let logPath = "/tmp/peek-space-drop-pasteboard.log"
FileManager.default.createFile(atPath: logPath, contents: nil)
let handle = FileHandle(forWritingAtPath: logPath)!
handle.seekToEndOfFile()

func log(_ s: String) {
  let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(s)\n"
  handle.write(line.data(using: .utf8)!)
  FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

let pb = NSPasteboard(name: .drag)
let probeTypes = ["public.url", "public.utf8-plain-text", "public.url-name",
                  "org.mozilla.MozillaWildcard"]

func dump(_ why: String) {
  log("\(why) changeCount=\(pb.changeCount) types=\((pb.types ?? []).map { $0.rawValue })")
  for (i, item) in (pb.pasteboardItems ?? []).enumerated() {
    log("  item \(i) types=\(item.types.map { $0.rawValue })")
    for t in probeTypes {
      let type = NSPasteboard.PasteboardType(t)
      if let s = item.string(forType: type) {
        log("    \(t) string=\(String(s.prefix(200)).replacingOccurrences(of: "\n", with: "\\n"))")
      } else if let d = item.data(forType: type) {
        log("    \(t) data=<\(d.count) bytes>")
      }
    }
  }
}

dump("start")
var last = pb.changeCount
let deadline = Date().addingTimeInterval(seconds)
while Date() < deadline {
  if pb.changeCount != last {
    last = pb.changeCount
    dump("changed")
  }
  Thread.sleep(forTimeInterval: 0.05)
}
dump("end")
