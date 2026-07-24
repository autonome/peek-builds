// frontmost-stream.swift — sample the owner of the macOS TOPMOST on-screen window.
//
// WHY THIS CHANGED (key-window vs frontmost-application):
//   The old oracle sampled NSWorkspace.frontmostApplication. That is BLIND to
//   the real theft we chase: an `_electron.launch`ed app grabs the macOS KEY
//   window (the topmost on-screen window, the one that owns keyboard input)
//   WITHOUT ever becoming the frontmost *application*. So the frontmost-app
//   oracle reported false "no theft" negatives. Operator confirmed live that
//   real launches DO steal the key window.
//
//   New oracle: enumerate on-screen windows front-to-back via
//   CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements])
//   (index 0 = topmost) and report the owner of the first "real" window — the
//   current key/active window on screen. If that owner PID becomes the launched
//   Electron PID, THAT is the theft signal.
//
// PERMISSIONS: reading window OWNER PID + LAYER + BOUNDS needs NO
//   Screen-Recording permission (only window NAMES do). We deliberately do NOT
//   read kCGWindowName for the decision, so this stays permission-free. Same as
//   apps/desktop/tests/helpers/cg-windows.swift.
//
// LAYER FILTERING (judgment call): a "key window" is a normal app window, which
//   lives on kCGWindowLayer == 0. Menubar, status items, the cursor, tooltips,
//   screensaver, notification banners etc. sit on ELEVATED layers and are never
//   the key window even though they're topmost in the raw list. So we pick the
//   FIRST layer-0 window in front-to-back order as "the topmost real window".
//   Layer 0 is the right default; if it ever proves too strict we'd revisit,
//   but for "who owns the key window" layer 0 is correct.
//
// Prints one CSV line per sample: <unix-seconds>,<ownerName>,<ownerPID>
//   - ownerName from kCGWindowOwnerName (commas stripped so the CSV stays 3-col)
//   - ownerPID  from kCGWindowOwnerPID  (this is the theft-attribution column)
//   - no layer-0 window in a sample → emits <unix-seconds>,none,-1
//
// Args: [durationSeconds=4.0] [intervalSeconds=0.05]
import CoreGraphics
import Foundation

let duration = CommandLine.arguments.count > 1 ? (Double(CommandLine.arguments[1]) ?? 4.0) : 4.0
let interval = CommandLine.arguments.count > 2 ? (Double(CommandLine.arguments[2]) ?? 0.05) : 0.05
let end = Date().addingTimeInterval(duration)

// OnScreenOnly guarantees front-to-back ordering (index 0 = topmost).
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]

while Date() < end {
  let ts = Date().timeIntervalSince1970
  var ownerName = "none"
  var ownerPID = -1

  if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
    for w in list {
      let layer = w[kCGWindowLayer as String] as? Int ?? -999
      // First layer-0 window in front-to-back order = the topmost real window
      // (the current key window on screen). Skip elevated layers (menubar,
      // status items, cursor, tooltips, screensaver, banners).
      guard layer == 0 else { continue }
      ownerPID = w[kCGWindowOwnerPID as String] as? Int ?? -1
      let rawName = w[kCGWindowOwnerName as String] as? String ?? "unknown"
      // Keep the CSV 3-column: strip commas out of the owner name.
      ownerName = rawName.replacingOccurrences(of: ",", with: " ")
      break
    }
  }

  print("\(ts),\(ownerName),\(ownerPID)")
  fflush(stdout)
  Thread.sleep(forTimeInterval: interval)
}
