---
name: release
description: Cut a release note — update CHANGELOG.md, regenerate the RSS feed (yarn rss; feed URLs use tangled.org, never github), commit. Use when the user asks for a changelog or RSS update.
---

# /release — Update changelog and RSS feed

When the user invokes /release:

1. Get recent commits since last changelog entry:
   ```
   git log --oneline -30 main
   ```

2. Read `CHANGELOG.md` to find the latest date heading (format: `## YYYY-MM-DD`).

3. Read recent commit messages between now and that date.

4. Add a new date section at the top of the changelog (after any header):
   - Use today's date or the date provided as argument
   - Group entries by area (features, fixes, docs, etc.)
   - Use concise descriptions based on commit messages
   - Follow the existing format in CHANGELOG.md

5. Regenerate the RSS feed:
   ```
   yarn rss
   ```

6. Commit both files:
   ```
   git commit -am "docs: update changelog and RSS feed for <date>"
   ```

## Important

- Read the existing CHANGELOG.md format carefully and match it exactly
- The RSS feed is generated from `@marss` metadata in CHANGELOG.md
- Feed URLs must use `tangled.org/burrito.space/peek/raw/main/` — NEVER github.com
- Only include commits that represent user-facing changes (skip merge commits, WIP, etc.)

## Usage

```
/release
/release 2026-03-18
```
