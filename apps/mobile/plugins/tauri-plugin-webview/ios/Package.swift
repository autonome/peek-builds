// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "tauri-plugin-webview",
    platforms: [
        .iOS(.v13)
    ],
    products: [
        .library(
            name: "tauri-plugin-webview",
            type: .static,
            targets: ["tauri-plugin-webview"]
        )
    ],
    dependencies: [
        .package(name: "Tauri", path: "../../../src-tauri/gen/apple/.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-webview",
            dependencies: [
                .product(name: "Tauri", package: "Tauri")
            ],
            path: "Sources"
        )
    ]
)
