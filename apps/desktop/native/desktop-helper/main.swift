// peek-desktop-helper — specs/kernel-desktops.md, section 5 "Helper protocol" and section 6
// "macOS: native helper, reads".
//
// Reads which desktops (Spaces) exist, which one each display shows, and which desktops a
// window is on, through the window server's private calls. Reads only: `place` is a
// diagnostic write attempt for the live acceptance check and is never used by the app.
//
// Protocol: one JSON object per line on stdin, one answer per line on stdout, in order.
//   request  {"id": <n>, "op": "hello" | "layout" | "placements" | "place", ...args}
//   answer   {"id": <n>, "ok": true, "result": <value>}  or  {"id": <n>, "ok": false, "error": "<text>"}
//   hello       → {"version": 1, "symbols": {"<name>": true|false, ...}}
//   layout      → {"screens": [{"display": "<CGDirectDisplayID>"|null, "current": "<id>"}],
//                  "desktops": [{"id": "<id>", "display": "<CGDirectDisplayID>"|null}]}
//   placements {"windows": [<window number>, ...]}
//               → [{"window": <n>, "display": "<id>"|null, "desktop": "<id>"|null,
//                   "onEveryDesktop": <bool>}, ...]   (one per window, in the order asked)
//   place {"window": <n>, "desktop": "<id>"}
//               → {"attempted": <bool>, "desktops": ["<id>", ...]}  (the window's desktops after)
// `display: null` means desktops are shared across every display. A desktop id is the window
// server's numeric space id as a decimal string. A missing private symbol is reported `false` in
// `hello` and makes the requests that need it answer an error; it never stops the helper.
// End of stdin ends the helper.
import ApplicationServices  // CGDisplayCreateUUIDFromDisplayID (ColorSync)
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let helperVersion = 1

// MARK: - Private symbols, resolved at start

typealias MainConnectionFn = @convention(c) () -> Int32
typealias CopyManagedDisplaySpacesFn = @convention(c) (Int32) -> Unmanaged<CFArray>?
typealias CopySpacesForWindowsFn = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?
typealias MoveWindowsToManagedSpaceFn = @convention(c) (Int32, CFArray, UInt64) -> Void

let rtldDefault = UnsafeMutableRawPointer(bitPattern: -2)
_ = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)

/// The first of `names` that resolves, under the name that resolved.
func resolve(_ names: [String]) -> (String, UnsafeMutableRawPointer)? {
  for name in names {
    if let p = dlsym(rtldDefault, name) { return (name, p) }
  }
  return nil
}

var symbolReport: [String: Bool] = [:]

func load<T>(_ names: [String], as type: T.Type) -> T? {
  let found = resolve(names)
  symbolReport[names[0]] = found != nil
  guard let (_, p) = found else { return nil }
  return unsafeBitCast(p, to: T.self)
}

let mainConnection = load(["CGSMainConnectionID", "SLSMainConnectionID"], as: MainConnectionFn.self)
let copyManagedDisplaySpaces = load(
  ["CGSCopyManagedDisplaySpaces", "SLSCopyManagedDisplaySpaces"], as: CopyManagedDisplaySpacesFn.self)
let copySpacesForWindows = load(
  ["CGSCopySpacesForWindows", "SLSCopySpacesForWindows"], as: CopySpacesForWindowsFn.self)
let moveWindowsToManagedSpace = load(
  ["CGSMoveWindowsToManagedSpace", "SLSMoveWindowsToManagedSpace"], as: MoveWindowsToManagedSpaceFn.self)

let connection: Int32? = mainConnection?()

struct HelperError: Error { let text: String }

// MARK: - Layout

/// Display UUID (upper case) → CGDirectDisplayID, over the active displays.
func activeDisplays() -> [(id: CGDirectDisplayID, uuid: String)] {
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
  return ids.prefix(Int(count)).compactMap { id in
    guard let uuid = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue(),
      let s = CFUUIDCreateString(nil, uuid) as String?
    else { return nil }
    return (id, s.uppercased())
  }
}

func spaceId(_ space: [String: Any]) -> String? {
  if let n = space["ManagedSpaceID"] as? NSNumber { return n.stringValue }
  if let n = space["id64"] as? NSNumber { return n.stringValue }
  return nil
}

struct Layout {
  var screens: [[String: Any]] = []
  var desktops: [[String: Any]] = []
  /// Desktop id → its display (`NSNull` = shared).
  var displayOf: [String: Any] = [:]
}

func readLayout() throws -> Layout {
  guard let cid = connection, let copy = copyManagedDisplaySpaces else {
    throw HelperError(text: "unavailable")
  }
  guard let raw = copy(cid)?.takeRetainedValue() as? [[String: Any]] else {
    throw HelperError(text: "no-display-spaces")
  }
  let displays = activeDisplays()
  let shared = raw.count == 1 && (raw[0]["Display Identifier"] as? String) == "Main"
    && displays.count > 1
  var layout = Layout()
  for entry in raw {
    let ident = (entry["Display Identifier"] as? String) ?? ""
    let display: Any
    if shared {
      display = NSNull()
    } else if ident == "Main" {
      display = String(CGMainDisplayID())
    } else if let match = displays.first(where: { $0.uuid == ident.uppercased() }) {
      display = String(match.id)
    } else {
      continue  // a display the window server lists but that is not active
    }
    let spaces = (entry["Spaces"] as? [[String: Any]]) ?? []
    for space in spaces {
      guard let id = spaceId(space) else { continue }
      layout.desktops.append(["id": id, "display": display])
      layout.displayOf[id] = display
    }
    if let current = entry["Current Space"] as? [String: Any], let id = spaceId(current),
      layout.displayOf[id] != nil
    {
      layout.screens.append(["display": display, "current": id])
    }
  }
  return layout
}

// MARK: - Placements

func spacesOf(window: Int) throws -> [String] {
  guard let cid = connection, let copy = copySpacesForWindows else {
    throw HelperError(text: "unavailable")
  }
  let list = [NSNumber(value: window)] as CFArray
  guard let raw = copy(cid, 0x7, list)?.takeRetainedValue() as? [NSNumber] else { return [] }
  return raw.map { $0.stringValue }
}

func placements(_ windows: [Int]) throws -> [[String: Any]] {
  let layout = try readLayout()
  return try windows.map { window in
    let spaces = try spacesOf(window: window)
    let every = spaces.count > 1
    let desktop: Any = spaces.count == 1 ? spaces[0] : NSNull()
    let display: Any = spaces.count == 1 ? (layout.displayOf[spaces[0]] ?? NSNull()) : NSNull()
    return ["window": window, "display": display, "desktop": desktop, "onEveryDesktop": every]
  }
}

func place(window: Int, desktop: String) throws -> [String: Any] {
  guard let space = UInt64(desktop) else { throw HelperError(text: "bad-desktop") }
  var attempted = false
  if let cid = connection, let move = moveWindowsToManagedSpace {
    move(cid, [NSNumber(value: window)] as CFArray, space)
    attempted = true
  }
  return ["attempted": attempted, "desktops": try spacesOf(window: window)]
}

// MARK: - Loop

func answer(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
    let line = String(data: data, encoding: .utf8)
  else {
    print("{\"id\":null,\"ok\":false,\"error\":\"encode\"}")
    return
  }
  print(line)
}

func handle(_ req: [String: Any]) throws -> Any {
  switch req["op"] as? String {
  case "hello":
    return ["version": helperVersion, "symbols": symbolReport]
  case "layout":
    let l = try readLayout()
    return ["screens": l.screens, "desktops": l.desktops]
  case "placements":
    guard let windows = req["windows"] as? [NSNumber] else { throw HelperError(text: "bad-windows") }
    return try placements(windows.map { $0.intValue })
  case "place":
    guard let window = (req["window"] as? NSNumber)?.intValue, let desktop = req["desktop"] as? String
    else { throw HelperError(text: "bad-place") }
    return try place(window: window, desktop: desktop)
  default:
    throw HelperError(text: "unknown-op")
  }
}

while let line = readLine() {
  if line.isEmpty { continue }
  guard let data = line.data(using: .utf8),
    let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  else {
    answer(["id": NSNull(), "ok": false, "error": "bad-request"])
    continue
  }
  let id = req["id"] ?? NSNull()
  do {
    answer(["id": id, "ok": true, "result": try handle(req)])
  } catch let e as HelperError {
    answer(["id": id, "ok": false, "error": e.text])
  } catch {
    answer(["id": id, "ok": false, "error": "failed"])
  }
}
