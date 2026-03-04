# THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!!

# Copyright 2020-2023 Tauri Programme within The Commons Conservancy
# SPDX-License-Identifier: Apache-2.0
# SPDX-License-Identifier: MIT

-keep class com.dietrich.peek_mobile.* {
  native <methods>;
}

-keep class com.dietrich.peek_mobile.WryActivity {
  public <init>(...);

  void setWebView(com.dietrich.peek_mobile.RustWebView);
  java.lang.Class getAppClass(...);
  java.lang.String getVersion();
}

-keep class com.dietrich.peek_mobile.Ipc {
  public <init>(...);

  @android.webkit.JavascriptInterface public <methods>;
}

-keep class com.dietrich.peek_mobile.RustWebView {
  public <init>(...);

  void loadUrlMainThread(...);
  void loadHTMLMainThread(...);
  void evalScript(...);
}

-keep class com.dietrich.peek_mobile.RustWebChromeClient,com.dietrich.peek_mobile.RustWebViewClient {
  public <init>(...);
}
