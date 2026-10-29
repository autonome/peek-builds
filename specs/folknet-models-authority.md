---
enabled: true
touches: [apps/desktop/main/feature-registry.ts, apps/desktop/main/feature-registry.test.ts, apps/desktop/main/feature-installer.ts, apps/desktop/main/feature-installer.test.ts, apps/desktop/main/tile-tokens.ts, apps/desktop/main/tile-tokens.test.ts, apps/desktop/main/tile-launcher.ts, apps/desktop/main/tile-launcher.test.ts, docs/design/folknet-peeklets.md]
depends-on: [folknet-peeklet-models]
---

# Folknet models A: persistent install identity and models consent

Milestone A of the Folknet peeklet models split (`folknet-peeklet-models.md`,
"Scope of this spec"). Offline only: no transport enablement, credentials,
provider contact, jobs or deployment. Design: `docs/design/folknet-peeklets.md`.
The proposal behind this split is in that track's handoff, "Proposed scope
amendment" §1.

## What changes

- `feature-registry.ts` (`FeatureRegistryEntry`, `RegistryData`, `loadRegistry`,
  `saveRegistry`, `registerFeature`, `unregisterFeature`, `disableFeature`,
  `enableFeature`, `FeatureRegistryListener`): persist a registry-allocated
  installation identity and a models grant revision per entry. Add one mutation
  API for models consent (proposed `replaceModelConsent`); IPC never writes entry
  fields directly. Persist before reporting success. Publish grant replacement and
  revocation to listeners. `installedAt`, `manifestCid` and `grantedCapabilities`
  are not revision identities.
- Migration: existing entries load with models denied until explicit consent.
- `feature-installer.ts` (`scanBuiltinFeatures`, `installFromLocalDirectory`,
  `registerLocalDirectory`, `installFromBundle`, `syncBuiltinFeatures`): every
  entry gets its identity from the registry. Ordinary reload or update keeps the
  identity; reinstall rotates it. Consent or policy replacement and revocation
  rotate the grant revision. `userApproved` or builtin status never creates
  models consent.
- `tile-tokens.ts` (`TokenRecord`, `generateToken`, `validateToken`, `revokeToken`,
  `revokeTokensForTile`, `clearAllTokens`): bind profile, installation and grant
  revision at minting; validation compares them with current registry authority;
  every revocation path, including bulk, notifies a host cancellation port. Token
  randomness or creation time is never a durable identity.
- `tile-launcher.ts` (`TileLaunchOptions`, `launchTile`,
  `getTileWebPreferencesForUrl`, `getTileWebPreferencesForWebviewUrl`,
  `registerTrustedBuiltinWindow`): resolve grants with the current registry
  consent, not the request alone. Models are denied on any launch path without
  durable authority and an eagerly bound sender.

## Done

Tests cover restart and migration, reinstall, update/reload, changed and revoked
grants, every token minting path, bulk revocation notification, and that legacy,
builtin and `userApproved` entries stay models-denied. No existing tile behavior
changes for capabilities other than models.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```
