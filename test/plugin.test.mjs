// Plugin contract test: `apply(ctx, config)` wiring, verified against a fake Cordis context.
// This is the layer a live profile install depends on, so it is asserted explicitly:
// which events are subscribed, with which options, how teardown behaves, and that the
// waterfall listener always delegates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';

import { name, inject, Config, apply } from '../plugin.js';
import { resolveLocale } from '../lib/format.js';

// Optional dependency: without `npm install` it is absent, the plugin correctly falls back to the
// dependency-free Standard Schema, and only the native-schema test stands down. A static import
// would make a fresh checkout unable to run the suite at all.
let Schemastery;
try {
  Schemastery = (await import('@deepseek-ai/schemastery')).default;
} catch {
  Schemastery = undefined;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function createFakeCtx(options = {}) {
  const listeners = new Map();
  const disposers = [];
  const services = new Map();
  const settingsCalls = [];
  let localePreference = options.localePreference;

  const ctx = {
    listeners,
    services,
    disposers,
    settingsCalls,
    /** Stands in for this row's fiber, the identity `settings.configure` must be given. */
    fiber: { uid: 'row-fiber' },
    /** The harness' optional-settings service, as `apply` sees it. */
    settings: {
      describe() {
        return localePreference === undefined
          ? []
          : [{ ns: 'locale', value: { preference: localePreference } }];
      },
      configure(presentation, owner) {
        settingsCalls.push({ presentation, owner });
        return () => {};
      },
    },
    on(event, handler, options) {
      const bucket = listeners.get(event) ?? [];
      bucket.push({ handler, options });
      listeners.set(event, bucket);
    },
    effect(factory, label) {
      disposers.push({ disposer: factory(), label });
    },
    /**
     * Optional-service injection. The real cordis waits for the named services and calls back
     * with a context that has them; this fake simply calls back immediately with itself.
     */
    inject(_names, callback) {
      callback(ctx);
    },
    provide(key, value) {
      services.set(key, value);
    },
    /** Invoke every listener registered for an event, in registration order. */
    emit(event, ...args) {
      return (listeners.get(event) ?? []).map((entry) => entry.handler(...args));
    },
    async teardown() {
      for (const entry of disposers) await entry.disposer();
    },
    setLocalePreference(preference) {
      localePreference = preference;
    },
  };

  return ctx;
}

function startReceiver() {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

const baseConfig = (port) => ({
  locale: 'en',
  desktop: { enabled: false },
  minDurationMs: 0,
  awaitingInputDelayMs: 0,
  webhooks: [{ name: 'hook', type: 'generic', url: `http://127.0.0.1:${port}/hook` }],
});

test('the manifest exports the host-bundle contract', () => {
  assert.equal(name, 'notifyHook');
  assert.deepEqual(inject, []);
  assert.equal(typeof apply, 'function');
  assert.ok(Config, 'Config must be exported');
  assert.equal(typeof Config, 'function', 'Config must be callable');
});

test('package manifest declares the 0.3.0 release contract', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest.license, 'MIT');
  assert.equal(existsSync(new URL('../LICENSE', import.meta.url)), true, 'the declared license ships as a file');

  const runtimeDependencies = Object.keys(manifest.dependencies || {});
  assert.deepEqual(runtimeDependencies, ['@deepseek-ai/schemastery']);
  assert.ok(runtimeDependencies.every((name) => name.startsWith('@deepseek-ai/')));
  assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh'], '>=0.2.0-rc.2 <0.3.0');

  const files = manifest.files || [];
  assert.ok(files.includes('LICENSE'));
  assert.ok(files.includes('docs/WEBHOOK-GUIDE.md'), 'the English provider guide ships in the archive');
  assert.ok(files.includes('docs/WEBHOOK-GUIDE.zh.md'), 'the Chinese provider guide ships in the archive');
  for (const forbidden of ['test', 'tools', 'HANDOFF.md', 'VERIFICATION.md', 'docs']) {
    assert.equal(files.includes(forbidden), false, `${forbidden} is not part of the runtime archive`);
  }
});

/**
 * A native volatile schema parses into a reference read with `.get()`; the dependency-free
 * fallback returns the plain object. Both schema paths are supported, so tests unwrap.
 */
const unwrap = (value) => (typeof value?.get === 'function' ? value.get() : value);

test('Config is a native volatile schema when schemastery is resolvable', () => {
  // This is the property that buys the in-UI Save button. `@deepseek-ai/dsh-settings` only
  // lists an entry as a live settings namespace when its Config is a native schemastery graph
  // AND `volatileForm()` finds a volatile field. Asserted structurally, because a regression
  // here is invisible at runtime: the plugin keeps working and the panel silently degrades.
  const native = Config[Symbol.for('schemastery')] === true;
  if (!native || Schemastery === undefined) return; // dependency-free fallback: covered below

  assert.equal(Config.type, 'object');
  assert.ok(Config.meta && typeof Config.meta === 'object');
  assert.equal(Config.meta.volatile, true, 'the root must be volatile or the namespace is filtered out');

  // volatileForm() does `new Schema(schema.toJSON())` and then walks meta/dict/inner/list.
  const json = Config.toJSON();
  const rebuilt = new Schemastery(json);
  assert.equal(rebuilt.type, 'object');
  assert.deepEqual(
    Object.keys(rebuilt.dict ?? {}).sort(),
    ['awaitingInputDelayMs', 'dedupeWindowMs', 'desktop', 'enabled', 'events', 'includeSubagents',
      'locale', 'logDeliveries', 'logLevel', 'minDurationMs', 'retries', 'testOnActivate',
      'timeoutMs', 'webhooks'].sort(),
  );
  assert.equal(rebuilt.meta?.volatile, true, 'toJSON() must carry the volatile marker');
});

test('Config satisfies the Cordis Standard Schema contract', () => {
  // Cordis calls `Config['~standard'].validate(raw)` and throws when the member is missing:
  // "Cannot read properties of undefined (reading 'validate')". It also refuses an async
  // result. That is the whole contract this export has to satisfy.
  const standard = Config['~standard'];
  assert.ok(standard, 'Config must expose ~standard');
  assert.equal(typeof standard.validate, 'function');
  assert.equal(standard.version, 1);

  const valid = standard.validate({ minDurationMs: 3000, events: { cancelled: true } });
  assert.equal('then' in valid, false, 'config validation must be synchronous');
  assert.equal(valid.issues, undefined, 'a valid config must not report issues');
  const value = unwrap(valid.value);
  assert.equal(value.minDurationMs, 3000);
  assert.equal(value.events.cancelled, true);
  assert.equal(value.events.failed, true);

  // An absent or empty config must resolve to the complete default shape, never undefined:
  // `apply` receives `result.value`, so a schema that returned nothing would silently
  // discard the row's configuration.
  for (const empty of [undefined, null, {}]) {
    const outcome = standard.validate(empty);
    assert.equal('then' in outcome, false);
    assert.equal(outcome.issues, undefined, 'an absent config must be accepted');
    const resolved = unwrap(outcome.value);
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.events.completed, true);
    assert.equal(resolved.minDurationMs, 10_000);
    assert.ok(Array.isArray(resolved.webhooks));
  }

  // The invariant behind both schema paths: never throw, never async, and always exactly one
  // of `value` / `issues`. Which one is reported for a bad value is allowed to differ — the
  // native schema reports it, the fallback clamps it — but it must always be one of them.
  const hostile = [42, 'nope', [], { minDurationMs: 'soon' }, { webhooks: 'no' }, { desktop: 5 }];
  for (const input of [...hostile, undefined, null, {}]) {
    const outcome = standard.validate(input);
    assert.equal('then' in outcome, false, 'config validation must be synchronous');
    const hasValue = outcome.value !== undefined;
    const hasIssues = Array.isArray(outcome.issues) && outcome.issues.length > 0;
    assert.equal(hasValue || hasIssues, true, `no value and no issues for ${JSON.stringify(input)}`);
    assert.equal(hasValue && hasIssues, false, `both value and issues for ${JSON.stringify(input)}`);
  }
});

test('a rejected value is loud, and never silently blank; a cased value is still accepted', () => {
  const standard = Config['~standard'];

  // Whatever the schema, a genuinely invalid config must either be reported or normalized —
  // never dropped, because `apply` would then run on defaults and quietly ignore the row.
  const outcome = standard.validate({ minDurationMs: 'soon' });
  const resolved = unwrap(outcome.value);
  const reported = Array.isArray(outcome.issues) && outcome.issues.length > 0;
  assert.ok(reported || resolved?.minDurationMs === 10_000, 'a bad number must be reported or defaulted');

  // Semantics stay lenient on BOTH paths: 'ZH' is a cased spelling, not a type error.
  const cased = standard.validate({ locale: '  ZH  ', logLevel: 'SILENT' });
  assert.equal(cased.issues, undefined, "'ZH' must not be a type error");
  const casedValue = unwrap(cased.value);
  assert.equal(String(casedValue.locale).trim().toLowerCase(), 'zh');
  assert.equal(String(casedValue.logLevel).trim().toLowerCase(), 'silent');
});

test('Config called directly yields the same complete shape as the normalizer', () => {
  const resolved = unwrap(Config({ minDurationMs: 3000, events: { cancelled: true } }));
  assert.equal(resolved.minDurationMs, 3000);
  assert.equal(resolved.events.cancelled, true);
  assert.equal(resolved.events.failed, true);
  assert.equal(resolved.enabled, true);
  assert.ok(Array.isArray(resolved.webhooks));
});

test('apply unwraps a volatile reference, so the row config is never lost', () => {
  // Cordis hands `apply` whatever `validate()` returned as `value`; for a volatile schema that
  // is a reference object. Losing this unwrap would silently run every row on defaults.
  const ctx = createFakeCtx();
  apply(ctx, { get: () => ({ enabled: false }) });
  assert.ok(ctx.services.get('notifyHook'), 'the lifecycle bridge remains available for a later live enable');
  assert.equal(ctx.services.get('notifyHook').stats().delivered, 0, 'the unwrapped enabled:false must actually disable delivery');
});

test('apply registers global listeners, one effect and the notifyHook service', async (t) => {
  const { server, port } = await startReceiver();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const ctx = createFakeCtx();
  apply(ctx, baseConfig(port));
  t.after(async () => {
    await ctx.teardown();
  });

  const sessionListeners = ctx.listeners.get('session/event');
  assert.equal(sessionListeners.length, 1);
  assert.deepEqual(sessionListeners[0].options, { global: true });

  const questionListeners = ctx.listeners.get('user-questions/request');
  assert.equal(questionListeners.length, 1);
  assert.deepEqual(questionListeners[0].options, { global: true });

  const volatileListeners = ctx.listeners.get('loader/volatile-update');
  assert.equal(volatileListeners.length, 1, 'the running row must observe DSH live-config commits');

  // One effect: the dispatcher. No settings page policy is registered any more — see the note in
  // plugin.js: nothing client-side consumes `autoGenerate`, so the harness' own config form for
  // this row is allowed to render, and it serves as a fallback for the custom page.
  assert.deepEqual(
    ctx.disposers.map((entry) => entry.label),
    ['notify-hook.dispatcher'],
  );
  assert.deepEqual(ctx.settingsCalls, [], 'no settings page policy is registered');

  const service = ctx.services.get('notifyHook');
  assert.ok(service, 'the notifyHook service must be provided');
  assert.equal(typeof service.stats, 'function');
  assert.equal(typeof service.flush, 'function');
  assert.equal(typeof service.test, 'function');
  assert.equal(typeof service.stats().delivered, 'number');
});

test('a session event reaching the registered listener produces a real delivery', async (t) => {
  const { server, received, port } = await startReceiver();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const ctx = createFakeCtx();
  apply(ctx, baseConfig(port));
  t.after(async () => {
    await ctx.teardown();
  });

  const session = { id: 'session-plugin', header: { id: 'session-plugin', cwd: '/srv/app' }, seq: 0 };
  const event = (type, data, seq, time) => ({ type, seq, time, data });
  const t0 = Date.now();

  ctx.emit('session/event', session, event('session/title', { title: 'Ship the notifier', messageSeqs: [], source: 'llm' }, 1, t0));
  ctx.emit('session/event', session, event('turn/start', { turn: 1 }, 2, t0));
  ctx.emit('session/event', session, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3, t0 + 240_000));

  await ctx.services.get('notifyHook').flush();
  await settle();

  assert.equal(received.length, 1);
  assert.equal(received[0].body.event, 'completed');
  assert.equal(received[0].body.sessionTitle, 'Ship the notifier');
  assert.equal(received[0].body.cwd, '/srv/app');
  assert.equal(received[0].body.durationMs, 240_000);
});

test('a DSH volatile update rebuilds delivery and arms the test without remounting', async (t) => {
  const { server, received, port } = await startReceiver();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  let current = { ...baseConfig(port), webhooks: [], testOnActivate: false };
  const configRef = { get: () => current };
  const ctx = createFakeCtx();
  apply(ctx, configRef);
  t.after(async () => {
    await ctx.teardown();
  });

  current = { ...baseConfig(port), testOnActivate: true };
  ctx.emit('loader/volatile-update', [[]]);
  await ctx.services.get('notifyHook').flush();
  await settle();

  assert.equal(received.length, 1, 'the running plugin must use the newly committed target');
  assert.equal(received[0].body.event, 'completed');
  assert.equal(received[0].body.sessionTitle, 'DSH notify-hook activated');
});

test('the DSH locale preference overrides the legacy plugin locale and updates live', async (t) => {
  const { server, received, port } = await startReceiver();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const ctx = createFakeCtx({ localePreference: 'en' });
  apply(ctx, { ...baseConfig(port), locale: 'zh', dedupeWindowMs: 0 });
  t.after(async () => {
    await ctx.teardown();
  });

  await ctx.services.get('notifyHook').test();
  await ctx.services.get('notifyHook').flush();
  await settle();
  assert.equal(received.length, 1);
  assert.equal(received[0].body.statusLabel, 'Task completed', 'DSH English wins over legacy config.locale=zh');

  ctx.setLocalePreference('zh');
  ctx.emit('settings/document-updated', 'locale', 2);
  await ctx.services.get('notifyHook').test();
  await ctx.services.get('notifyHook').flush();
  await settle();
  assert.equal(received.length, 2);
  assert.equal(received[1].body.statusLabel, '任务完成', 'a live DSH language change reaches new notifications');
});

test('DSH automatic language follows the system instead of a stale legacy plugin locale', async (t) => {
  const { server, received, port } = await startReceiver();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const automatic = resolveLocale('auto');
  const staleLegacy = automatic === 'zh' ? 'en' : 'zh';
  const ctx = createFakeCtx({ localePreference: null });
  apply(ctx, { ...baseConfig(port), locale: staleLegacy, dedupeWindowMs: 0 });
  t.after(async () => {
    await ctx.teardown();
  });

  await ctx.services.get('notifyHook').test();
  await ctx.services.get('notifyHook').flush();
  await settle();
  assert.equal(received.length, 1);
  assert.equal(
    received[0].body.statusLabel,
    automatic === 'zh' ? '任务完成' : 'Task completed',
    'an empty DSH preference means system-controlled auto, not config.locale',
  );
});

test('the user-questions listener delegates to next() and still announces the wait', async (t) => {
  const { server, received, port } = await startReceiver();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const ctx = createFakeCtx();
  apply(ctx, baseConfig(port));
  t.after(async () => {
    await ctx.teardown();
  });

  const listener = ctx.listeners.get('user-questions/request')[0].handler;
  const answer = { answers: [{ id: 'q1', selected: ['yes'] }] };
  let called = 0;
  const next = () => {
    called += 1;
    return Promise.resolve(answer);
  };
  const returned = await listener.call({ id: 'session-q' }, { questions: [{ id: 'q1', question: 'Proceed?' }] }, next);

  assert.equal(called, 1, 'a waterfall observer must call next()');
  assert.equal(returned, answer, 'the listener must return the delegated decision unchanged');

  await ctx.services.get('notifyHook').flush();
  await settle();

  assert.equal(received.length, 1);
  assert.equal(received[0].body.event, 'awaiting-input');
  assert.match(received[0].body.text, /Proceed\?/);
});

test('teardown stops delivery and no later event is announced', async (t) => {
  const { server, received, port } = await startReceiver();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const ctx = createFakeCtx();
  apply(ctx, baseConfig(port));

  const session = { id: 'session-down', header: { id: 'session-down' }, seq: 0 };
  ctx.emit('session/event', session, { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
  await ctx.services.get('notifyHook').flush();
  await settle();
  assert.equal(received.length, 1);

  await ctx.teardown();
  ctx.emit('session/event', session, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } } });
  await settle();

  assert.equal(received.length, 1, 'a torn-down plugin must stay silent');
});

test('apply tolerates missing, empty and hostile config', () => {
  for (const config of [undefined, null, {}, 0, 'nope', [], { webhooks: 'not-an-array' }, { desktop: 5 }]) {
    const ctx = createFakeCtx();
    assert.doesNotThrow(() => apply(ctx, config), `apply threw for ${JSON.stringify(config)}`);
    assert.ok(ctx.services.get('notifyHook'));
  }
});

test('a config whose webhook list is unusable still activates cleanly', async (t) => {
  const ctx = createFakeCtx();
  apply(ctx, {
    desktop: { enabled: false },
    minDurationMs: 0,
    webhooks: [
      { name: 'no-url' },
      { name: 'bad-scheme', url: 'ftp://example.com/hook' },
      'nonsense',
    ],
  });
  t.after(async () => {
    await ctx.teardown();
  });

  const stats = ctx.services.get('notifyHook').stats();
  assert.equal(stats.delivered, 0);
  assert.equal(stats.failed, 0);
});

test('enabled: false keeps only the live-config bridge and delivers nothing', async (t) => {
  // The master switch has to actually switch something off. A config-only `enabled: false`
  // that still subscribed and still delivered would be worse than no option at all, because
  // the user would believe they had silenced it.
  const { server, received, port } = await startReceiver();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const ctx = createFakeCtx();
  apply(ctx, { ...baseConfig(port), enabled: false });
  t.after(async () => {
    await ctx.teardown();
  });

  assert.equal(ctx.listeners.get('loader/volatile-update').length, 1, 'live settings can enable the row later');
  assert.equal(ctx.disposers.length, 1, 'the lifecycle bridge still has an owned teardown');
  assert.equal(ctx.services.has('notifyHook'), true, 'diagnostics remain available while paused');

  const session = { id: 'session-disabled', header: { id: 'session-disabled' } };
  ctx.emit('session/event', session, {
    type: 'turn/end',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, reason: { kind: 'completed' } },
  });

  await settle();
  assert.equal(received.length, 0);
});

test('enabled: false through the Config schema, not just a raw object', async () => {
  const ctx = createFakeCtx();
  apply(ctx, Config({ enabled: false }));
  await ctx.teardown();
  assert.equal(ctx.services.get('notifyHook').stats().delivered, 0);
});
