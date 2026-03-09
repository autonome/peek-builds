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

    tauri_build::build()
}
