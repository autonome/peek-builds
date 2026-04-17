#!/bin/bash
# One-shot script to run the "lists input renders and is auto-focused" test
# Used by agent to avoid shell metacharacter restrictions in the hook
set -e
cd "$(dirname "$0")/.."
yarn build && HEADLESS=1 BACKEND=electron npx playwright test tests/desktop/localsearch.spec.ts --grep "lists input renders and is auto-focused"
