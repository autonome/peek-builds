// Lets an ordinary window take key without activating the app
// (docs/design/kernel-desktops-implementation.md, "Research: Electron panels
// and desktops", candidate 1).
//
// An Electron panel is on every desktop whatever is asked, so a page shown over
// another app is drawn on the desktop being switched to. An ordinary window is
// managed: it stays on the desktop it was first ordered on. What an ordinary
// window lacks is the ability to become key while its app is inactive, which
// AppKit grants only to a non-activating panel.
//
// A true class swap is impossible: the window's isa is already the KVO
// subclass `NSKVONotifying_ElectronNSWindow`, and subclassing that traps. So the
// window's real class gains an `_isNonactivatingPanel` override (private,
// on NSWindow) that answers YES for a window carrying this addon's flag and
// NSWindow's own answer for every other window; the flag also sets the window
// server's prevents-activation tag (`_setPreventsActivation:`, private).
// Live-verified on macOS 26 with Electron 43: with another app in front, the
// flagged window becomes key, keeps the other app frontmost, receives typing,
// and stays on the desktop it opened on.
//
// A flagged window also moves to the current desktop each time it is shown
// (move-to-active collection behaviour), so a window kept alive and re-shown
// appears where the user is instead of staying, invisible yet key, on the
// desktop it was last shown on. It never follows a switch while visible.
// AppKit rejects that behaviour together with joining every desktop, so a
// flagged window must never be put on every desktop.
//
// Electron's `focus()` (window or web contents) activates the app for any
// non-panel, so a flagged window takes key through `makeKey` and gives its web
// content focus through `focusContent` instead.
//
// Every call takes the buffer `getNativeWindowHandle()` returns (an NSView
// pointer) and must run on the main thread, which is where Electron's main
// process runs JavaScript.

#import <AppKit/AppKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <node_api.h>

static char kNonActivatingFlag;
static BOOL (*gWindowIsNonactivatingPanel)(id, SEL) = nullptr;

static BOOL FlaggedIsNonactivatingPanel(id self, SEL sel) {
  if (objc_getAssociatedObject(self, &kNonActivatingFlag) != nil) return YES;
  return gWindowIsNonactivatingPanel != nullptr ? gWindowIsNonactivatingPanel(self, sel) : NO;
}

// Adds the override to the window's real class (`-class` hides the KVO
// subclass). class_addMethod adds only where the class does not implement the
// selector itself, so a class that already overrides it is left alone.
static bool InstallOverride(NSWindow* window) {
  SEL selector = NSSelectorFromString(@"_isNonactivatingPanel");
  Method base = class_getInstanceMethod([NSWindow class], selector);
  if (base == nullptr) return false;
  if (gWindowIsNonactivatingPanel == nullptr) {
    gWindowIsNonactivatingPanel = reinterpret_cast<BOOL (*)(id, SEL)>(method_getImplementation(base));
  }
  Class real = [window class];
  class_addMethod(real, selector, reinterpret_cast<IMP>(FlaggedIsNonactivatingPanel), method_getTypeEncoding(base));
  return class_getMethodImplementation(real, selector) == reinterpret_cast<IMP>(FlaggedIsNonactivatingPanel);
}

static NSWindow* WindowFromHandle(napi_env env, napi_value value) {
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, value, &data, &length) != napi_ok || length < sizeof(void*)) return nil;
  NSView* view = *reinterpret_cast<NSView* __unsafe_unretained*>(data);
  return view != nil ? [view window] : nil;
}

static NSWindow* WindowArg(napi_env env, napi_callback_info info, bool* flag) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) return nil;
  if (flag != nullptr && (argc < 2 || napi_get_value_bool(env, args[1], flag) != napi_ok)) return nil;
  return WindowFromHandle(env, args[0]);
}

static napi_value JsBool(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

// setNonActivating(handle, on) -> true when the window now behaves as asked.
static napi_value SetNonActivating(napi_env env, napi_callback_info info) {
  bool on = false;
  NSWindow* window = WindowArg(env, info, &on);
  if (window == nil) return JsBool(env, false);
  if (on && !InstallOverride(window)) return JsBool(env, false);
  objc_setAssociatedObject(window, &kNonActivatingFlag, on ? @YES : nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  SEL prevents = NSSelectorFromString(@"_setPreventsActivation:");
  if ([window respondsToSelector:prevents]) {
    reinterpret_cast<void (*)(id, SEL, BOOL)>(objc_msgSend)(window, prevents, on ? YES : NO);
  }
  NSWindowCollectionBehavior behavior =
      window.collectionBehavior & ~(NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorMoveToActiveSpace);
  window.collectionBehavior = on ? (behavior | NSWindowCollectionBehaviorMoveToActiveSpace) : behavior;
  return JsBool(env, true);
}

// makeKey(handle) -> true when the window is key afterwards. Orders the window
// front and makes it key without asking the app to activate.
static napi_value MakeKey(napi_env env, napi_callback_info info) {
  NSWindow* window = WindowArg(env, info, nullptr);
  if (window == nil) return JsBool(env, false);
  [window makeKeyAndOrderFront:nil];
  return JsBool(env, [window isKeyWindow]);
}

static NSView* FirstWebContentView(NSView* view) {
  if (view.hidden) return nil;
  if ([NSStringFromClass([view class]) isEqualToString:@"RenderWidgetHostViewCocoa"]) return view;
  for (NSView* child in view.subviews) {
    NSView* found = FirstWebContentView(child);
    if (found != nil) return found;
  }
  return nil;
}

// focusContent(handle) -> true when the window's first visible web content
// view is now its first responder. Chromium treats that as content focus.
static napi_value FocusContent(napi_env env, napi_callback_info info) {
  NSWindow* window = WindowArg(env, info, nullptr);
  if (window == nil) return JsBool(env, false);
  NSView* content = FirstWebContentView(window.contentView);
  return JsBool(env, content != nil && [window makeFirstResponder:content]);
}

// isKey(handle) -> whether the window is the key window now.
static napi_value IsKey(napi_env env, napi_callback_info info) {
  NSWindow* window = WindowArg(env, info, nullptr);
  return JsBool(env, window != nil && [window isKeyWindow]);
}

static napi_value Init(napi_env env, napi_value exports) {
  struct { const char* name; napi_callback fn; } exported[] = {
    {"setNonActivating", SetNonActivating},
    {"makeKey", MakeKey},
    {"focusContent", FocusContent},
    {"isKey", IsKey},
  };
  for (const auto& entry : exported) {
    napi_value fn;
    napi_create_function(env, entry.name, NAPI_AUTO_LENGTH, entry.fn, nullptr, &fn);
    napi_set_named_property(env, exports, entry.name, fn);
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
