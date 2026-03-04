// PeekTheme.swift
// Auto-generated from CSS theme — DO NOT EDIT manually.
// Run: node scripts/generate-swift-theme.js
//
// Source files:
//   themes/peek/variables.css
//   extensions/tags/home.css

import UIKit

// MARK: - Peek Theme Colors
/// Matches the Peek app's Base16 theme from themes/peek/variables.css
struct PeekTheme {

    // MARK: - Light Mode Palette
    struct Light {
        static let base00 = UIColor(red: 0xF6/255.0, green: 0xF6/255.0, blue: 0xF6/255.0, alpha: 1) // #f6f6f6 bg
        static let base01 = UIColor(red: 0xFF/255.0, green: 0xFF/255.0, blue: 0xFF/255.0, alpha: 1) // #ffffff card bg
        static let base02 = UIColor(red: 0xE0/255.0, green: 0xE0/255.0, blue: 0xE0/255.0, alpha: 1) // #e0e0e0 borders
        static let base03 = UIColor(red: 0x99/255.0, green: 0x99/255.0, blue: 0x99/255.0, alpha: 1) // #999999 muted
        static let base04 = UIColor(red: 0x66/255.0, green: 0x66/255.0, blue: 0x66/255.0, alpha: 1) // #666666 secondary
        static let base05 = UIColor(red: 0x33/255.0, green: 0x33/255.0, blue: 0x33/255.0, alpha: 1) // #333333 text
        static let base06 = UIColor(red: 0x1A/255.0, green: 0x1A/255.0, blue: 0x1A/255.0, alpha: 1) // #1a1a1a light fg
        static let base07 = UIColor(red: 0x0F/255.0, green: 0x0F/255.0, blue: 0x0F/255.0, alpha: 1) // #0f0f0f darkest
        static let base08 = UIColor(red: 0xFF/255.0, green: 0x3B/255.0, blue: 0x30/255.0, alpha: 1) // #ff3b30 red
        static let base09 = UIColor(red: 0xFF/255.0, green: 0x95/255.0, blue: 0x00/255.0, alpha: 1) // #ff9500 orange
        static let base0A = UIColor(red: 0xFF/255.0, green: 0xCC/255.0, blue: 0x00/255.0, alpha: 1) // #ffcc00 yellow
        static let base0B = UIColor(red: 0x34/255.0, green: 0xC7/255.0, blue: 0x59/255.0, alpha: 1) // #34c759 green
        static let base0C = UIColor(red: 0x5A/255.0, green: 0xC8/255.0, blue: 0xFA/255.0, alpha: 1) // #5ac8fa cyan
        static let base0D = UIColor(red: 0x00/255.0, green: 0x7A/255.0, blue: 0xFF/255.0, alpha: 1) // #007aff blue
        static let base0E = UIColor(red: 0xAF/255.0, green: 0x52/255.0, blue: 0xDE/255.0, alpha: 1) // #af52de purple
        static let base0F = UIColor(red: 0x8B/255.0, green: 0x45/255.0, blue: 0x13/255.0, alpha: 1) // #8b4513 brown
    }

    // MARK: - Dark Mode Palette
    struct Dark {
        static let base00 = UIColor(red: 0x1C/255.0, green: 0x1C/255.0, blue: 0x1E/255.0, alpha: 1) // #1c1c1e bg
        static let base01 = UIColor(red: 0x2C/255.0, green: 0x2C/255.0, blue: 0x2E/255.0, alpha: 1) // #2c2c2e card bg
        static let base02 = UIColor(red: 0x3A/255.0, green: 0x3A/255.0, blue: 0x3C/255.0, alpha: 1) // #3a3a3c borders
        static let base03 = UIColor(red: 0x63/255.0, green: 0x63/255.0, blue: 0x66/255.0, alpha: 1) // #636366 muted
        static let base04 = UIColor(red: 0x98/255.0, green: 0x98/255.0, blue: 0x9D/255.0, alpha: 1) // #98989d secondary
        static let base05 = UIColor(red: 0xF6/255.0, green: 0xF6/255.0, blue: 0xF6/255.0, alpha: 1) // #f6f6f6 text
        static let base06 = UIColor(red: 0xFF/255.0, green: 0xFF/255.0, blue: 0xFF/255.0, alpha: 1) // #ffffff light fg
        static let base07 = UIColor(red: 0xFF/255.0, green: 0xFF/255.0, blue: 0xFF/255.0, alpha: 1) // #ffffff lightest
        static let base08 = UIColor(red: 0xFF/255.0, green: 0x45/255.0, blue: 0x3A/255.0, alpha: 1) // #ff453a red
        static let base09 = UIColor(red: 0xFF/255.0, green: 0x9F/255.0, blue: 0x0A/255.0, alpha: 1) // #ff9f0a orange
        static let base0A = UIColor(red: 0xFF/255.0, green: 0xD6/255.0, blue: 0x0A/255.0, alpha: 1) // #ffd60a yellow
        static let base0B = UIColor(red: 0x30/255.0, green: 0xD1/255.0, blue: 0x58/255.0, alpha: 1) // #30d158 green
        static let base0C = UIColor(red: 0x64/255.0, green: 0xD2/255.0, blue: 0xFF/255.0, alpha: 1) // #64d2ff cyan
        static let base0D = UIColor(red: 0x0A/255.0, green: 0x84/255.0, blue: 0xFF/255.0, alpha: 1) // #0a84ff blue
        static let base0E = UIColor(red: 0xBF/255.0, green: 0x5A/255.0, blue: 0xF2/255.0, alpha: 1) // #bf5af2 purple
        static let base0F = UIColor(red: 0xAC/255.0, green: 0x8E/255.0, blue: 0x68/255.0, alpha: 1) // #ac8e68 brown
    }

    /// Adaptive color that switches between light and dark variants
    static func adaptive(light: UIColor, dark: UIColor) -> UIColor {
        return UIColor { traitCollection in
            traitCollection.userInterfaceStyle == .dark ? dark : light
        }
    }

    // MARK: - Semantic Adaptive Colors
    static let bg = adaptive(light: Light.base00, dark: Dark.base00)  // --theme-bg
    static let bgSecondary = adaptive(light: Light.base01, dark: Dark.base01)  // --theme-bg-secondary
    static let bgTertiary = adaptive(light: Light.base02, dark: Dark.base02)  // --theme-bg-tertiary
    static let border = adaptive(light: Light.base02, dark: Dark.base02)  // --theme-border
    static let textMuted = adaptive(light: Light.base03, dark: Dark.base03)  // --theme-text-muted
    static let textSecondary = adaptive(light: Light.base04, dark: Dark.base04)  // --theme-text-secondary
    static let text = adaptive(light: Light.base05, dark: Dark.base05)  // --theme-text
    static let textLight = adaptive(light: Light.base06, dark: Dark.base06)  // light foreground
    static let accent = adaptive(light: Light.base0D, dark: Dark.base0D)  // --theme-accent (blue)
    static let success = adaptive(light: Light.base0B, dark: Dark.base0B)  // --theme-success (green)
    static let warning = adaptive(light: Light.base0A, dark: Dark.base0A)  // --theme-warning (yellow)
    static let danger = adaptive(light: Light.base08, dark: Dark.base08)  // --theme-danger (red)
    static let orange = adaptive(light: Light.base09, dark: Dark.base09)  // orange
    static let cyan = adaptive(light: Light.base0C, dark: Dark.base0C)  // cyan
    static let purple = adaptive(light: Light.base0E, dark: Dark.base0E)  // purple
    static let brown = adaptive(light: Light.base0F, dark: Dark.base0F)  // brown

    // MARK: - Selected Tag Colors (color-mix approximations)
    // CSS: background: color-mix(in srgb, var(--base0D) 20%, var(--base01))
    // Approximated as blue at 20% opacity over card bg
    static let selectedTagBg = adaptive(
        light: Light.base0D.withAlphaComponent(0.20),
        dark: Dark.base0D.withAlphaComponent(0.20)
    )
    // CSS: border: 1px solid color-mix(in srgb, var(--base0D) 30%, transparent)
    static let selectedTagBorder = adaptive(
        light: Light.base0D.withAlphaComponent(0.3),
        dark: Dark.base0D.withAlphaComponent(0.3)
    )

    // MARK: - Monospace Font Helper
    /// Monospace font matching --theme-font-sans (ServerMono / SF Mono fallback chain)
    static func mono(size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        if let sfMono = UIFont(name: "SFMono-Regular", size: size) {
            switch weight {
            case .medium:
                return UIFont(name: "SFMono-Medium", size: size) ?? sfMono
            case .semibold:
                return UIFont(name: "SFMono-Semibold", size: size) ?? sfMono
            case .bold:
                return UIFont(name: "SFMono-Bold", size: size) ?? sfMono
            default:
                return sfMono
            }
        }
        return .monospacedSystemFont(ofSize: size, weight: weight)
    }

    // MARK: - Type Scale
    // CSS px values scaled up ~1.25x for native UIKit to visually match
    // the web app's rendering (CSS px ≠ UIKit pt at the same numeric value).

    /// .header-title — CSS 15px → 18pt
    static let headerTitle = mono(size: 18, weight: .semibold)

    /// .detail-title — CSS 14px → 17pt
    static let title = mono(size: 17, weight: .semibold)

    /// .detail-url / .empty-state — CSS 13px → 15pt
    static let body = mono(size: 15)

    /// .new-tag-input / .add-tag-btn / .card-title — CSS 12px → 14pt
    static let input = mono(size: 14)

    /// .add-tag-btn / .card-title — CSS 12px → 14pt medium
    static let inputMedium = mono(size: 14, weight: .medium)

    /// .current-tag / .available-tag / .card-url — CSS 11px → 13pt
    static let caption = mono(size: 13)

    /// .detail-label / .sidebar-title — CSS 11px → 13pt semibold uppercase
    static let sectionLabel = mono(size: 13, weight: .semibold)

    /// .detail-save-status / .filter-count — CSS 11px → 13pt medium
    static let captionMedium = mono(size: 13, weight: .medium)

    /// .card-tag — CSS 10px → 12pt
    static let micro = mono(size: 12)

    // MARK: - Border Radii (from CSS)

    /// .current-tag / .available-tag border-radius — visually matched to main app
    static let tagCornerRadius: CGFloat = 6

    /// .tag-chip (sidebar) border-radius — 5px
    static let tagChipCornerRadius: CGFloat = 5

    /// .card-tag border-radius — 8px
    static let cardTagCornerRadius: CGFloat = 8

    /// .new-tag-input border-radius — 6px
    static let inputCornerRadius: CGFloat = 6

    /// .add-tag-btn border-radius — 5px
    static let buttonCornerRadius: CGFloat = 5

    /// --peek-card-radius / image preview — 6px
    static let cardCornerRadius: CGFloat = 6

    // MARK: - Tag Padding (from CSS)

    /// .current-tag padding: 2px 7px → scaled ~1.25x for native
    static let currentTagPaddingV: CGFloat = 3
    static let currentTagPaddingH: CGFloat = 9

    /// .available-tag padding: 3px 8px → scaled ~1.25x for native
    static let availableTagPaddingV: CGFloat = 4
    static let availableTagPaddingH: CGFloat = 10

    /// .card-tag padding: 1px 6px
    static let cardTagPaddingV: CGFloat = 1
    static let cardTagPaddingH: CGFloat = 6

    /// .add-tag-btn padding: 5px 12px → scaled ~1.25x for native
    static let buttonPaddingV: CGFloat = 6
    static let buttonPaddingH: CGFloat = 15

    // MARK: - Spacing

    /// Standard content gap (stack view spacing)
    static let spacingMD: CGFloat = 12

    /// Tight spacing (tag gap, inter-item)
    static let spacingSM: CGFloat = 4

    /// Section margin between label and content
    static let spacingXS: CGFloat = 6

    /// Page-level horizontal padding
    static let paddingH: CGFloat = 16

    /// Content top padding below header
    static let paddingTop: CGFloat = 10
}
