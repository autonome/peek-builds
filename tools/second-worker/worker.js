/**
 * The second worker: `docs/worker-runtime-portability.md` §8 argues that the
 * case after hello-world is not a bigger worker but the same shape, extended
 * with the three things `tools/hello-worker` never exercised — a manifest
 * that denies a network domain, a schedule that fires more than once, and a
 * channel that delivers one command. Between them, `tools/second-worker/run.mjs`
 * turns four of the five host operations that document's §4.6 named
 * unimplemented — `installGlobals`, `ensureSchedule`, `cancelSchedule`,
 * `openChannel` — into code a real run exercises. The fifth, `RunContext`, is
 * the second parameter this worker actually reads, unlike `hello-worker`'s
 * `worker.js`, which takes only `api`.
 *
 * `capturedApi` mirrors `apps/desktop/renderer/cmd/nouns.js`, which reads
 * `window.app` on its own first line (`docs/workers-design.md` §13.4/§13.5's
 * measurement). It is exported rather than acted on here, because whether it
 * is *this run's* `api` object is a fact about the host's module loading, not
 * about the feature — `run.mjs`'s `runWorker()` is what checks it, right
 * after importing this module and before calling the entry function.
 */
export const capturedApi = globalThis.window?.app;

/** The entry function. `ctx` is the RunContext of docs/worker-runtime-portability.md §4.2. */
export async function second(api, ctx) {
  if (!ctx) {
    throw new Error(
      'second-worker requires a RunContext as the second argument — see docs/worker-runtime-portability.md §4.2'
    );
  }

  api.log(`run start: trigger="${ctx.trigger.kind}", deadline in ${ctx.deadline - Date.now()}ms`);

  switch (ctx.trigger.kind) {
    case 'schedule':
      return onSchedule(api, ctx);
    case 'command':
      return onCommand(api, ctx);
    case 'wake':
      api.log(`wake on topic "${ctx.trigger.topic}"`);
      return { handled: 'wake' };
    default:
      throw new Error(`unknown trigger kind "${ctx.trigger.kind}"`);
  }
}

async function onSchedule(api, ctx) {
  const session = await api.datastore.describe();
  api.log(`store backend "${session.backend}", scheduled for ${new Date(ctx.trigger.scheduledFor).toISOString()}`);

  // manifest.json grants only "allowed.example". Reaching for a domain
  // outside the grant proves the network guard denies it rather than
  // assuming the manifest is decorative (docs/worker-runtime-portability.md
  // §6.7). Caught rather than left to fail the run: a realistic feature
  // author handles a denied source the way `feeds` handles an unreachable
  // one, not by crashing. The conformance suite's own assertion 5
  // (docs/worker-runtime-portability.md §8) is the place an *uncaught* denial
  // is exercised, with a probe worker built for exactly that.
  try {
    await fetch('https://denied.example/config');
    api.log('unexpected: a fetch to a domain outside the grant succeeded');
  } catch (err) {
    api.log(`network guard denied as declared: ${err.message}`);
  }

  return { scheduledFor: ctx.trigger.scheduledFor };
}

async function onCommand(api, ctx) {
  const { name, params, resultTopic } = ctx.trigger;
  api.log(`command "${name}" received, params=${JSON.stringify(params)}`);
  if (resultTopic) {
    // ctx.waitUntil: the result publish is not awaited by the entry function
    // itself, so on a platform with no such concept the host awaits it before
    // finishing the run (docs/worker-runtime-portability.md §6.6) rather than
    // dropping it.
    ctx.waitUntil(
      api.publish(resultTopic, { name, ok: true }).then(() => api.log(`result published on "${resultTopic}"`))
    );
  }
  return { command: name, ok: true };
}

export default second;
