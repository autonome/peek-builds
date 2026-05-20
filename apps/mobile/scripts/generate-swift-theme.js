#!/usr/bin/env node
/**
 * generate-swift-theme.js
 *
 * Reads the Peek CSS theme variables and tag/home CSS files and generates
 * a Swift PeekTheme struct for the iOS Share Extension.
 *
 * Usage:  node scripts/generate-swift-theme.js
 * Output: src-tauri/gen/apple/Peek/PeekTheme.swift
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Paths (relative to apps/mobile/)
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..', '..', '..');
const VARIABLES_CSS = path.join(ROOT, 'themes', 'peek', 'variables.css');
const TAGS_CSS = path.join(ROOT, 'extensions', 'tags', 'home.css');
const OUTPUT = path.join(__dirname, '..', 'src-tauri', 'gen', 'apple', 'Peek', 'PeekTheme.swift');

// ---------------------------------------------------------------------------
// CSS Parsing
// ---------------------------------------------------------------------------

/**
 * Parse CSS custom properties from a block of text.
 * Returns a Map of variable-name -> value.
 */
function parseCSSVars(css) {
  const vars = new Map();
  // Match --variable-name: value; patterns
  const re = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    vars.set(m[1], m[2].trim());
  }
  return vars;
}

/**
 * Extract CSS blocks by selector pattern.
 * Returns the content between { }.
 */
function extractBlock(css, selectorPattern) {
  const idx = css.indexOf(selectorPattern);
  if (idx === -1) return '';
  const start = css.indexOf('{', idx);
  if (start === -1) return '';
  let depth = 1;
  let i = start + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') depth--;
    i++;
  }
  return css.substring(start + 1, i - 1);
}

/**
 * Parse a hex color (#RGB or #RRGGBB) into {r, g, b} 0-255.
 */
function parseHex(hex) {
  hex = hex.trim().replace('#', '');
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  return {
    r: parseInt(hex.substring(0, 2), 16),
    g: parseInt(hex.substring(2, 4), 16),
    b: parseInt(hex.substring(4, 6), 16),
  };
}

/**
 * Extract a CSS property value from a block by property name.
 * e.g. extractProp(block, 'border-radius') -> '10px'
 */
function extractProp(block, prop) {
  // Match property: value; allowing for multi-value
  const re = new RegExp(`(?:^|[;{}\\s])${prop.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*:\\s*([^;]+);`, 'm');
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Parse a pixel value like '10px' -> 10
 */
function parsePx(val) {
  if (!val) return null;
  const m = val.match(/([\d.]+)\s*px/);
  return m ? parseFloat(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Read CSS files
// ---------------------------------------------------------------------------
const variablesCss = fs.readFileSync(VARIABLES_CSS, 'utf8');
const tagsCss = fs.readFileSync(TAGS_CSS, 'utf8');

// ---------------------------------------------------------------------------
// Extract color palettes
// ---------------------------------------------------------------------------

// Light mode: :root block (the first one, before @media)
const rootBlock = extractBlock(variablesCss, ':root {');
const lightVars = parseCSSVars(rootBlock);

// Dark mode: inside @media (prefers-color-scheme: dark)
const darkMediaBlock = extractBlock(variablesCss, '@media (prefers-color-scheme: dark)');
const darkVars = parseCSSVars(darkMediaBlock);

// Base16 color names
const BASE_NAMES = [
  'base00', 'base01', 'base02', 'base03', 'base04', 'base05', 'base06', 'base07',
  'base08', 'base09', 'base0A', 'base0B', 'base0C', 'base0D', 'base0E', 'base0F',
];

// Build color maps
const lightColors = {};
const darkColors = {};

for (const name of BASE_NAMES) {
  const lVal = lightVars.get(name);
  const dVal = darkVars.get(name);
  if (lVal) lightColors[name] = parseHex(lVal);
  if (dVal) darkColors[name] = parseHex(dVal);
}

// ---------------------------------------------------------------------------
// Extract sizing tokens from tags/home.css
// ---------------------------------------------------------------------------

// Tag geometry
const currentTagBlock = extractBlock(tagsCss, '.current-tag {');
const availableTagBlock = extractBlock(tagsCss, '.available-tag {');
const tagChipBlock = extractBlock(tagsCss, '.tag-chip {');
const cardTagBlock = extractBlock(tagsCss, '.card-tag {');

const currentTagRadius = parsePx(extractProp(currentTagBlock, 'border-radius'));   // 10px
const availableTagRadius = parsePx(extractProp(availableTagBlock, 'border-radius')); // 10px
const tagChipRadius = parsePx(extractProp(tagChipBlock, 'border-radius'));         // 5px
const cardTagRadius = parsePx(extractProp(cardTagBlock, 'border-radius'));         // 8px

// Font sizes
const headerTitleBlock = extractBlock(tagsCss, '.header-title {');
const detailTitleBlock = extractBlock(tagsCss, '.detail-title {');
const detailUrlBlock = extractBlock(tagsCss, '.detail-url {');
const newTagInputBlock = extractBlock(tagsCss, '.new-tag-input {');
const addTagBtnBlock = extractBlock(tagsCss, '.add-tag-btn {');
const sidebarTitleBlock = extractBlock(tagsCss, '.sidebar-title {');
const cardTitleBlock = extractBlock(tagsCss, '.card-title {');
const emptyStateBlock = extractBlock(tagsCss, '.empty-state {');
const detailSaveStatusBlock = extractBlock(tagsCss, '.detail-save-status {');
const cardUrlBlock = extractBlock(tagsCss, '.card-url {');

const fontSize = {
  headerTitle: parsePx(extractProp(headerTitleBlock, 'font-size')),       // 15
  detailTitle: parsePx(extractProp(detailTitleBlock, 'font-size')),       // 14
  detailUrl: parsePx(extractProp(detailUrlBlock, 'font-size')),           // 13
  newTagInput: parsePx(extractProp(newTagInputBlock, 'font-size')),       // 12
  addTagBtn: parsePx(extractProp(addTagBtnBlock, 'font-size')),           // 12
  cardTitle: parsePx(extractProp(cardTitleBlock, 'font-size')),           // 12
  sidebarTitle: parsePx(extractProp(sidebarTitleBlock, 'font-size')),     // 11
  currentTag: parsePx(extractProp(currentTagBlock, 'font-size')),         // 11
  availableTag: parsePx(extractProp(availableTagBlock, 'font-size')),     // 11
  cardUrl: parsePx(extractProp(cardUrlBlock, 'font-size')),               // 11
  detailSaveStatus: parsePx(extractProp(detailSaveStatusBlock, 'font-size')), // 11
  emptyState: parsePx(extractProp(emptyStateBlock, 'font-size')),         // 13
  cardTag: parsePx(extractProp(cardTagBlock, 'font-size')),               // 10
};

// Border radii
const newTagInputRadius = parsePx(extractProp(newTagInputBlock, 'border-radius'));  // 6
const addTagBtnRadius = parsePx(extractProp(addTagBtnBlock, 'border-radius'));      // 5

// Padding tokens from CSS
const currentTagPadding = extractProp(currentTagBlock, 'padding');       // 2px 7px
const availableTagPadding = extractProp(availableTagBlock, 'padding');   // 3px 8px
const cardTagPadding = extractProp(cardTagBlock, 'padding');             // 1px 6px

// Parse padding shorthand "Vpx Hpx"
function parsePadding(val) {
  if (!val) return { v: 0, h: 0 };
  const parts = val.split(/\s+/).map(p => parsePx(p + (p.includes('px') ? '' : 'px'))).filter(Boolean);
  if (parts.length === 1) return { v: parts[0], h: parts[0] };
  return { v: parts[0], h: parts[1] };
}

const currentTagPad = parsePadding(currentTagPadding);
const availableTagPad = parsePadding(availableTagPadding);
const cardTagPad = parsePadding(cardTagPadding);

// Peek card radius from tags/home.css (--peek-card-radius: 6px)
const peekCardRadius = 6;

// html base font
const htmlBlock = extractBlock(tagsCss, 'html {');
const baseFontSize = parsePx(extractProp(htmlBlock, 'font-size')); // 14

// ---------------------------------------------------------------------------
// Swift Code Generation
// ---------------------------------------------------------------------------

function swiftColor(c, name, comment) {
  return `        static let ${name} = UIColor(red: 0x${c.r.toString(16).toUpperCase().padStart(2, '0')}/255.0, green: 0x${c.g.toString(16).toUpperCase().padStart(2, '0')}/255.0, blue: 0x${c.b.toString(16).toUpperCase().padStart(2, '0')}/255.0, alpha: 1) // ${comment}`;
}

function swiftColorName(name) {
  // base0A -> base0A, base00 -> base00
  return name;
}

const lightComments = {
  base00: 'bg',
  base01: 'card bg',
  base02: 'borders',
  base03: 'muted',
  base04: 'secondary',
  base05: 'text',
  base06: 'light fg',
  base07: 'darkest',
  base08: 'red',
  base09: 'orange',
  base0A: 'yellow',
  base0B: 'green',
  base0C: 'cyan',
  base0D: 'blue',
  base0E: 'purple',
  base0F: 'brown',
};

const darkComments = { ...lightComments };
darkComments.base00 = 'bg';
darkComments.base05 = 'text';
darkComments.base06 = 'light fg';
darkComments.base07 = 'lightest';

function hexStr(c) {
  return '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function genColorLines(colors, comments, structName) {
  const lines = [];
  for (const name of BASE_NAMES) {
    const c = colors[name];
    if (!c) continue;
    lines.push(swiftColor(c, name, `${hexStr(c)} ${comments[name]}`));
  }
  return lines;
}

const lightLines = genColorLines(lightColors, lightComments, 'Light');
const darkLines = genColorLines(darkColors, darkComments, 'Dark');

// Semantic adaptive color mappings
const semanticColors = [
  { name: 'bg', light: 'base00', dark: 'base00', comment: '--theme-bg' },
  { name: 'bgSecondary', light: 'base01', dark: 'base01', comment: '--theme-bg-secondary' },
  { name: 'bgTertiary', light: 'base02', dark: 'base02', comment: '--theme-bg-tertiary' },
  { name: 'border', light: 'base02', dark: 'base02', comment: '--theme-border' },
  { name: 'textMuted', light: 'base03', dark: 'base03', comment: '--theme-text-muted' },
  { name: 'textSecondary', light: 'base04', dark: 'base04', comment: '--theme-text-secondary' },
  { name: 'text', light: 'base05', dark: 'base05', comment: '--theme-text' },
  { name: 'textLight', light: 'base06', dark: 'base06', comment: 'light foreground' },
  { name: 'accent', light: 'base0D', dark: 'base0D', comment: '--theme-accent (blue)' },
  { name: 'success', light: 'base0B', dark: 'base0B', comment: '--theme-success (green)' },
  { name: 'warning', light: 'base0A', dark: 'base0A', comment: '--theme-warning (yellow)' },
  { name: 'danger', light: 'base08', dark: 'base08', comment: '--theme-danger (red)' },
  { name: 'orange', light: 'base09', dark: 'base09', comment: 'orange' },
  { name: 'cyan', light: 'base0C', dark: 'base0C', comment: 'cyan' },
  { name: 'purple', light: 'base0E', dark: 'base0E', comment: 'purple' },
  { name: 'brown', light: 'base0F', dark: 'base0F', comment: 'brown' },
];

const semanticLines = semanticColors.map(s =>
  `    static let ${s.name} = adaptive(light: Light.${s.light}, dark: Dark.${s.dark})  // ${s.comment}`
);

// Generate the Swift file
const swift = `// PeekTheme.swift
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
${lightLines.join('\n')}
    }

    // MARK: - Dark Mode Palette
    struct Dark {
${darkLines.join('\n')}
    }

    /// Adaptive color that switches between light and dark variants
    static func adaptive(light: UIColor, dark: UIColor) -> UIColor {
        return UIColor { traitCollection in
            traitCollection.userInterfaceStyle == .dark ? dark : light
        }
    }

    // MARK: - Semantic Adaptive Colors
${semanticLines.join('\n')}

    // MARK: - Selected Tag Colors (color-mix approximations)
    // CSS: background: color-mix(in srgb, var(--base0D) 20%, var(--base01))
    // Approximated as blue at 20% opacity over card bg
    static let selectedTagBg = adaptive(
        light: Light.base0D.withAlphaComponent(0.15),
        dark: Dark.base0D.withAlphaComponent(0.15)
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
    // Derived from actual CSS font-size / font-weight declarations.
    // Base html font-size: ${baseFontSize || 14}px, line-height: 1.5

    /// .header-title \u2014 ${fontSize.headerTitle}px semibold
    static let headerTitle = mono(size: ${fontSize.headerTitle || 15}, weight: .semibold)

    /// .detail-title \u2014 ${fontSize.detailTitle}px semibold
    static let title = mono(size: ${fontSize.detailTitle || 14}, weight: .semibold)

    /// .detail-url / .empty-state \u2014 ${fontSize.detailUrl || 13}px regular
    static let body = mono(size: ${fontSize.detailUrl || 13})

    /// .new-tag-input / .add-tag-btn / .card-title \u2014 ${fontSize.newTagInput || 12}px regular
    static let input = mono(size: ${fontSize.newTagInput || 12})

    /// .add-tag-btn / .card-title \u2014 ${fontSize.addTagBtn || 12}px medium
    static let inputMedium = mono(size: ${fontSize.addTagBtn || 12}, weight: .medium)

    /// .current-tag / .available-tag / .card-url / .detail-label \u2014 ${fontSize.currentTag || 11}px regular
    static let caption = mono(size: ${fontSize.currentTag || 11})

    /// .detail-label / .sidebar-title \u2014 ${fontSize.sidebarTitle || 11}px semibold uppercase
    static let sectionLabel = mono(size: ${fontSize.sidebarTitle || 11}, weight: .semibold)

    /// .detail-save-status / .filter-count \u2014 ${fontSize.detailSaveStatus || 11}px medium
    static let captionMedium = mono(size: ${fontSize.detailSaveStatus || 11}, weight: .medium)

    /// .card-tag \u2014 ${fontSize.cardTag || 10}px (small tag text on cards)
    static let micro = mono(size: ${fontSize.cardTag || 10})

    // MARK: - Border Radii (from CSS)

    /// .current-tag / .available-tag border-radius \u2014 ${currentTagRadius}px
    static let tagCornerRadius: CGFloat = ${currentTagRadius || 10}

    /// .tag-chip (sidebar) border-radius \u2014 ${tagChipRadius}px
    static let tagChipCornerRadius: CGFloat = ${tagChipRadius || 5}

    /// .card-tag border-radius \u2014 ${cardTagRadius}px
    static let cardTagCornerRadius: CGFloat = ${cardTagRadius || 8}

    /// .new-tag-input border-radius \u2014 ${newTagInputRadius}px
    static let inputCornerRadius: CGFloat = ${newTagInputRadius || 6}

    /// .add-tag-btn border-radius \u2014 ${addTagBtnRadius}px
    static let buttonCornerRadius: CGFloat = ${addTagBtnRadius || 5}

    /// --peek-card-radius / image preview \u2014 ${peekCardRadius}px
    static let cardCornerRadius: CGFloat = ${peekCardRadius}

    // MARK: - Tag Padding (from CSS)

    /// .current-tag padding: ${currentTagPadding}
    static let currentTagPaddingV: CGFloat = ${currentTagPad.v}
    static let currentTagPaddingH: CGFloat = ${currentTagPad.h}

    /// .available-tag padding: ${availableTagPadding}
    static let availableTagPaddingV: CGFloat = ${availableTagPad.v}
    static let availableTagPaddingH: CGFloat = ${availableTagPad.h}

    /// .card-tag padding: ${cardTagPadding}
    static let cardTagPaddingV: CGFloat = ${cardTagPad.v}
    static let cardTagPaddingH: CGFloat = ${cardTagPad.h}

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
`;

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------
const outputDir = path.dirname(OUTPUT);
if (!fs.existsSync(outputDir)) {
  console.error(`Output directory does not exist: ${outputDir}`);
  process.exit(1);
}

fs.writeFileSync(OUTPUT, swift, 'utf8');
console.log(`Generated ${OUTPUT}`);
console.log(`  Light colors: ${Object.keys(lightColors).length}`);
console.log(`  Dark colors:  ${Object.keys(darkColors).length}`);
console.log(`  Font sizes extracted: ${Object.values(fontSize).filter(Boolean).length}`);
console.log(`  Tag radius: ${currentTagRadius}px (current/available), ${tagChipRadius}px (chip), ${cardTagRadius}px (card)`);
