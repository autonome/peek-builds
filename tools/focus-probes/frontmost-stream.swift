// frontmost-stream.swift — sample the macOS frontmost (active) application.
//
// Prints one CSV line per sample: <unix-seconds>,<bundle-id-or-name>
// Uses NSWorkspace.frontmostApplication, which needs NO Accessibility /
// Screen-Recording permission (unlike System Events / CGWindowList reads of
// other apps). This is the oracle the focus-probe specs never had: an
// automated "which app is active right now" signal.
//
// Args: [durationSeconds=4.0] [intervalSeconds=0.05]
import AppKit
import Foundation

let duration = CommandLine.arguments.count > 1 ? (Double(CommandLine.arguments[1]) ?? 4.0) : 4.0
let interval = CommandLine.arguments.count > 2 ? (Double(CommandLine.arguments[2]) ?? 0.05) : 0.05
let end = Date().addingTimeInterval(duration)
while Date() < end {
  let f = NSWorkspace.shared.frontmostApplication
  let id = f?.bundleIdentifier ?? f?.localizedName ?? "unknown"
  print("\(Date().timeIntervalSince1970),\(id)")
  fflush(stdout)
  Thread.sleep(forTimeInterval: interval)
}
