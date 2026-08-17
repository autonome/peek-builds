/**
 * Shared key normalization for the remote MCP credential file
 * (~/.config/peek/mcp-credentials.json). setup.js `writeCredentialFile()`
 * and server.js `resolveCredentialFromFile()` both build/read the
 * `<url>#<scope>` key independently — importing from here instead of each
 * concatenating its own is what keeps them from drifting apart (e.g. one
 * side trimming a trailing slash and the other not).
 *
 * The url half is normalized exactly the way `openRemoteStore()`
 * (store/remote-store.js) normalizes its HTTP base url — trim, then drop
 * trailing slashes — so a credential-file key and the url actually dialed
 * always agree on what counts as "the same server". The scope half is a tag
 * name, not a network address, and is left untouched.
 */

export function normalizeCredentialUrl(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

// Builds the key from its two parts, e.g. for writeCredentialFile().
export function credentialKey(url, scope) {
  return `${normalizeCredentialUrl(url)}#${scope}`;
}

// Normalizes an already-assembled "<url>#<scope>" key, e.g. the
// PEEK_MCP_CREDENTIAL value resolveCredentialFromFile() receives. Splits on
// the FIRST '#' — matches how credentialKey() assembles it, url first.
export function normalizeCredentialKey(key) {
  const idx = key.indexOf('#');
  if (idx === -1) return key.trim();
  return credentialKey(key.slice(0, idx), key.slice(idx + 1));
}
