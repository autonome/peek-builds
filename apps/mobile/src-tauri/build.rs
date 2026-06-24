fn main() {
    let target = std::env::var("TARGET").unwrap();

    // Compile Objective-C bridge for iOS
    if target.contains("ios") {
        cc::Build::new()
            .file("AppGroupBridge.m")
            .compile("app_group_bridge");

        println!("cargo:rustc-link-lib=framework=Foundation");
    }

    // Android 16KB page size alignment (required for Android 15+ / API 35+)
    // This ensures LOAD segments in the .so are aligned to 16384 bytes.
    // Using cargo:rustc-link-arg here because .cargo/config.toml rustflags
    // can be overridden by CARGO_ENCODED_RUSTFLAGS set by the Tauri CLI.
    if target.contains("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }

    // Embed a build id so the running app can prove WHICH build it is (on-device
    // staleness check — see scripts/ios-cache.sh and the peek-device-verify skill).
    // The build scripts set PEEK_BUILD_ID; on a plain build it falls back to
    // "unknown". rerun-if-env-changed forces a recompile (and thus a fresh embed)
    // whenever the id changes, so a stale cache can't silently keep an old id.
    println!("cargo:rerun-if-env-changed=PEEK_BUILD_ID");
    let build_id = std::env::var("PEEK_BUILD_ID").unwrap_or_else(|_| "unknown".to_string());
    println!("cargo:rustc-env=PEEK_BUILD_ID={}", build_id);

    tauri_build::build()
}
