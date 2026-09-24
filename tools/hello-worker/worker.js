/**
 * The smallest possible Peek worker: a manifest with a `worker` entry point
 * (`manifest.json`), this module, and a host (`run.mjs`) that runs it with no
 * Electron and no window — the shape `docs/workers-design.md` §2–§5 describes,
 * proved on something simpler than `feeds`.
 *
 * The entry function only touches what a worker is granted (§5): `api.log`
 * and `api.datastore`. It never sees the sync credential — that stays in a
 * closure inside the host (`docs/workers-capabilities.md` §2.1) — and it
 * makes exactly one call, a read: `describe()`, the same operation
 * `GET /mcp/session` answers. No item is created, tagged or deleted.
 */
export async function hello(api) {
  api.log('hello from hello-worker');

  const session = await api.datastore.describe();
  api.log(
    `sync server reports scope "${session.scopeTag}" (readonly: ${session.readonly}, ` +
      `profile: ${session.profileId}, backend: ${session.backend})`
  );

  return session;
}

export default hello;
