// Ground-truth macOS window stack probe.
// Usage: swift cg-windows.swift <ownerPID>
// Prints JSON array of the owner's on-screen windows in FRONT-TO-BACK order
// (index 0 = frontmost). Bounds are available without Screen-Recording
// permission; window names usually are NOT, so callers map by bounds.
import CoreGraphics
import Foundation

guard CommandLine.arguments.count > 1, let pid = Int(CommandLine.arguments[1]) else {
  FileHandle.standardError.write("usage: cg-windows.swift <pid>\n".data(using: .utf8)!)
  exit(2)
}

// OnScreenOnly guarantees front-to-back ordering.
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
  print("[]")
  exit(0)
}

var out: [[String: Any]] = []
for w in list {
  guard let owner = w[kCGWindowOwnerPID as String] as? Int, owner == pid else { continue }
  let num = w[kCGWindowNumber as String] as? Int ?? -1
  let layer = w[kCGWindowLayer as String] as? Int ?? -999
  let name = w[kCGWindowName as String] as? String ?? ""
  let alpha = w[kCGWindowAlpha as String] as? Double ?? -1
  var x = 0.0, y = 0.0, ww = 0.0, hh = 0.0
  if let b = w[kCGWindowBounds as String] as? [String: Any] {
    x = (b["X"] as? Double) ?? 0
    y = (b["Y"] as? Double) ?? 0
    ww = (b["Width"] as? Double) ?? 0
    hh = (b["Height"] as? Double) ?? 0
  }
  out.append(["number": num, "layer": layer, "name": name, "alpha": alpha,
              "x": x, "y": y, "w": ww, "h": hh])
}
let data = try! JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
