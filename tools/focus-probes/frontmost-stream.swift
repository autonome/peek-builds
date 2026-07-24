// frontmost-stream.swift — dual focus sampler for oracle A/B validation.
//
// WHY TWO SIGNALS (the over-report we are chasing):
//   We are validating a macOS focus-theft oracle. The topmost-window oracle
//   OVER-REPORTS: it flags a `showInactive()` window as theft because it
//   measures the *topmost window in z-order*, which is NOT the same as the
//   *key/focused window*. A window can be topmost on screen without ever being
//   the frontmost application or owning keyboard focus. To pick the correct
//   oracle we emit BOTH independent signals per sample and compare each against
//   a human ground-truth observation:
//     A) frontmost-application signal — NSWorkspace.shared.frontmostApplication
//        (the app that owns the active/menu-bar focus).
//     B) topmost-window signal — the owner of the first on-screen layer-0 window
//        in front-to-back z-order (the raw topmost window, permission-free).
//
// PERMISSIONS: reading window OWNER PID + LAYER needs NO Screen-Recording
//   permission (only window NAMES do). We deliberately do NOT read
//   kCGWindowName for the decision, so this stays permission-free. Same as
//   apps/desktop/tests/helpers/cg-windows.swift.
//
// LAYER FILTERING (judgment call): a "key window" is a normal app window, which
//   lives on kCGWindowLayer == 0. Menubar, status items, the cursor, tooltips,
//   screensaver, notification banners etc. sit on ELEVATED layers. So we pick
//   the FIRST layer-0 window in front-to-back order as "the topmost real
//   window".
//
// Prints one 5-column CSV line per sample:
//   <unix-seconds>,<frontAppPID>,<frontAppName>,<topWinOwnerPID>,<topWinOwnerName>
//   - frontAppPID/frontAppName: NSWorkspace.shared.frontmostApplication —
//     processIdentifier and (bundleIdentifier ?? localizedName ?? "unknown").
//     nil frontmost app → -1,none
//   - topWinOwnerPID/topWinOwnerName: kCGWindowOwnerPID / kCGWindowOwnerName of
//     the topmost layer-0 window. No layer-0 window → -1,none
//   - both name fields have commas stripped (replaced with space) so the line
//     stays EXACTLY 5 columns.
//
// Args: [durationSeconds=4.0] [intervalSeconds=0.05]
import AppKit
import CoreGraphics
import Foundation

let duration = CommandLine.arguments.count > 1 ? (Double(CommandLine.arguments[1]) ?? 4.0) : 4.0
let interval = CommandLine.arguments.count > 2 ? (Double(CommandLine.arguments[2]) ?? 0.05) : 0.05
let end = Date().addingTimeInterval(duration)

// OnScreenOnly guarantees front-to-back ordering (index 0 = topmost).
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]

func stripCommas(_ s: String) -> String {
  return s.replacingOccurrences(of: ",", with: " ")
}

while Date() < end {
  let ts = Date().timeIntervalSince1970

  // Signal A: frontmost application.
  var frontAppPID = -1
  var frontAppName = "none"
  if let app = NSWorkspace.shared.frontmostApplication {
    frontAppPID = Int(app.processIdentifier)
    let rawName = app.bundleIdentifier ?? app.localizedName ?? "unknown"
    frontAppName = stripCommas(rawName)
  }

  // Signal B: owner of the topmost on-screen layer-0 window.
  var topWinOwnerPID = -1
  var topWinOwnerName = "none"
  if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
    for w in list {
      let layer = w[kCGWindowLayer as String] as? Int ?? -999
      // First layer-0 window in front-to-back order = the topmost real window.
      // Skip elevated layers (menubar, status items, cursor, tooltips,
      // screensaver, banners).
      guard layer == 0 else { continue }
      topWinOwnerPID = w[kCGWindowOwnerPID as String] as? Int ?? -1
      let rawName = w[kCGWindowOwnerName as String] as? String ?? "unknown"
      topWinOwnerName = stripCommas(rawName)
      break
    }
  }

  print("\(ts),\(frontAppPID),\(frontAppName),\(topWinOwnerPID),\(topWinOwnerName)")
  fflush(stdout)
  Thread.sleep(forTimeInterval: interval)
}
