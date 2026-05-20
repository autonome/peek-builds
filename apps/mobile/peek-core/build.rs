fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    uniffi::generate_scaffolding("src/peek_core.udl").unwrap();
}
