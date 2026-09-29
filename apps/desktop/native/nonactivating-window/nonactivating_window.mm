// Lets an ordinary window take key without activating the app
// (docs/design/kernel-desktops-implementation.md, "Research: Electron panels
// and desktops", candidate 1).
//
// An Electron panel is on every desktop whatever is asked, so a page shown over
// another app travels with the user on a desktop switch. An ordinary window is
// managed: it stays on the desktop it was first ordered on. What an ordinary
// window lacks is the window server's prevents-activation tag, which lets a
// window take key while its app stays inactive; `_setPreventsActivation:`
// (private, on NSWindow) sets or clears that tag.
//
// Every call takes the buffer `BrowserWindow.getNativeWindowHandle()` returns
// (an NSView pointer) and must run on the main thread, which is where Electron's
// main process runs JavaScript.

#import <AppKit/AppKit.h>
#import <objc/message.h>
#include <node_api.h>

static NSWindow* WindowFromHandle(napi_env env, napi_value value) {
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, value, &data, &length) != napi_ok || length < sizeof(void*)) return nil;
  NSView* view = *reinterpret_cast<NSView* __unsafe_unretained*>(data);
  return view != nil ? [view window] : nil;
}

static napi_value JsBool(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

// setPreventsActivation(handle, on) -> true when the window took the tag.
static napi_value SetPreventsActivation(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) return JsBool(env, false);
  NSWindow* window = WindowFromHandle(env, args[0]);
  bool on = false;
  napi_get_value_bool(env, args[1], &on);
  SEL selector = NSSelectorFromString(@"_setPreventsActivation:");
  if (window == nil || ![window respondsToSelector:selector]) return JsBool(env, false);
  void (*send)(id, SEL, BOOL) = reinterpret_cast<void (*)(id, SEL, BOOL)>(objc_msgSend);
  send(window, selector, on ? YES : NO);
  return JsBool(env, true);
}

// makeKey(handle) -> true when the window is key afterwards. Orders the window
// front and makes it key without asking the app to activate.
static napi_value MakeKey(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) return JsBool(env, false);
  NSWindow* window = WindowFromHandle(env, args[0]);
  if (window == nil) return JsBool(env, false);
  [window makeKeyAndOrderFront:nil];
  return JsBool(env, [window isKeyWindow]);
}

// isKey(handle) -> whether the window is the key window now.
static napi_value IsKey(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  NSWindow* window = argc < 1 ? nil : WindowFromHandle(env, args[0]);
  return JsBool(env, window != nil && [window isKeyWindow]);
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "isKey", NAPI_AUTO_LENGTH, IsKey, nullptr, &fn);
  napi_set_named_property(env, exports, "isKey", fn);
  napi_create_function(env, "setPreventsActivation", NAPI_AUTO_LENGTH, SetPreventsActivation, nullptr, &fn);
  napi_set_named_property(env, exports, "setPreventsActivation", fn);
  napi_create_function(env, "makeKey", NAPI_AUTO_LENGTH, MakeKey, nullptr, &fn);
  napi_set_named_property(env, exports, "makeKey", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
