// Orchestration tests: gating, debounce, dedupe and failure isolation.
// Everything is injected — no timers, no sockets, no host process.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Notifier } from '../lib/dispatch.js';
import { normalizeConfig } from '../lib/config.js';

const T0 = 1_700_000_000_000;

/** Deterministic clock + timer queue + delivery recorder. */
function createHarness(config = {}, { deliver } = {}) {
  let now = T0;
  let seq = 0;
  const timers = new Map();
  const calls = [];

  const scheduler = {
    setTimeout(callback, delayMs) {
      const id = (seq += 1);
      timers.set(id, { callback, at: now + delayMs });
      return { id, unref() {} };
    },
    clearTimeout(handle) {
      if (handle && typeof handle === 'object') timers.delete(handle.id);
    },
  };

  const notifier = new Notifier({
    config,
    now: () => now,
    scheduler,
    log() {},
    deliver:
      deliver ??
      (async (signal, notification, meta) => {
        calls.push({ signal, notification, meta });
        return { desktop: { ok: true }, webhooks: [] };
      }),
  });

  return {
    notifier,
    calls,
    scheduler,
    get now() {
      return now;
    },
    setNow(value) {
      now = value;
    },
    /** Advance the clock, firing every timer that becomes due (including newly queued ones). */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target);
        if (!due.length) break;
        now = Math.min(...due.map(([, timer]) => timer.at));
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.callback();
        }
      }
      now = target;
    },
    pendingTimers: () => timers.size,
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

function makeSession(id = 'session-1', header = {}) {
  return { id, header: { id, ...header }, seq: 0, snapshotEvents: () => [] };
}

function event(type, data, { seq = 1, time = T0 } = {}) {
  return { type, seq, time, data };
}

const turnEnd = (turn, reason, time) => event('turn/end', { turn, reason }, { time });

test('a completed turn is announced with its measured duration', async () => {
  const h = createHarness();
  const session = makeSession();
  h.notifier.onSessionEvent(session, event('turn/start', { turn: 1 }, { time: T0 }));
  h.notifier.onSessionEvent(session, turnEnd(1, { kind: 'completed' }, T0 + 133_000));
  await h.settle();

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.status, 'completed');
  assert.equal(h.calls[0].meta.durationMs, 133_000);
  assert.equal(h.calls[0].meta.sessionId, 'session-1');
});

test('a short completed turn stays silent, a short failure does not', async () => {
  const h = createHarness();
  const session = makeSession();

  h.notifier.onSessionEvent(session, event('turn/start', { turn: 1 }, { time: T0 }));
  h.notifier.onSessionEvent(session, turnEnd(1, { kind: 'completed' }, T0 + 900));
  await h.settle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.notifier.stats().bySkipReason['below-min-duration'], 1);

  h.notifier.onSessionEvent(session, event('turn/start', { turn: 2 }, { time: T0 + 1_000 }));
  h.notifier.onSessionEvent(session, turnEnd(2, { kind: 'error', error: { code: 'rate_limit', message: 'too many' } }, T0 + 1_100));
  await h.settle();

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.status, 'failed');
  assert.equal(h.calls[0].signal.errorCode, 'rate_limit');
  assert.equal(h.calls[0].signal.errorMessage, 'too many');
});

test('an approval prompt that resolves itself never notifies', async () => {
  const h = createHarness();
  const session = makeSession();

  h.notifier.onSessionEvent(session, event('approval/asked', { id: 'ap-1', toolName: 'pwsh' }));
  assert.equal(h.pendingTimers(), 1);

  h.advance(500);
  h.notifier.onSessionEvent(session, event('approval/decided', { id: 'ap-1', outcome: { kind: 'allowed' } }, { seq: 2 }));
  h.advance(10_000);
  await h.settle();

  assert.equal(h.calls.length, 0);
  assert.equal(h.pendingTimers(), 0);
  assert.equal(h.notifier.stats().bySkipReason['resolved-before-notify'], 1);
});

test('an approval prompt that stays open notifies after the delay', async () => {
  const h = createHarness();
  const session = makeSession();

  h.notifier.onSessionEvent(session, event('approval/asked', { id: 'ap-2', toolName: 'write_file' }));
  h.advance(2_499);
  await h.settle();
  assert.equal(h.calls.length, 0, 'must not fire before the delay');

  h.advance(1);
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.status, 'awaiting-input');
  assert.equal(h.calls[0].signal.toolName, 'write_file');
});

test('awaitingInputDelayMs 0 delivers immediately', async () => {
  const h = createHarness({ awaitingInputDelayMs: 0 });
  h.notifier.onSessionEvent(makeSession(), event('approval/asked', { id: 'ap-3', toolName: 'pwsh' }));
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.pendingTimers(), 0);
});

test('a turn end cancels a held approval notification', async () => {
  const h = createHarness();
  const session = makeSession();

  h.notifier.onSessionEvent(session, event('approval/asked', { id: 'ap-4', toolName: 'pwsh' }));
  h.advance(1_000);
  h.notifier.onSessionEvent(session, turnEnd(1, { kind: 'aborted', reason: { kind: 'legacy' } }, T0 + 1_000));
  h.advance(10_000);
  await h.settle();

  // Cancelled turns are off by default, but the held approval must be gone either way.
  assert.equal(h.pendingTimers(), 0);
  assert.equal(h.calls.filter((call) => call.signal.status === 'awaiting-input').length, 0);
});

test('a question from the agent is treated as awaiting input', async () => {
  const h = createHarness({ awaitingInputDelayMs: 0 });
  h.notifier.onUserQuestion(
    { id: 'session-q' },
    { questions: [{ id: 'q1', question: 'Which database should I target?' }], wait: { callId: 'call-9' } },
  );
  await h.settle();

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.status, 'awaiting-input');
  assert.equal(h.calls[0].signal.question, 'Which database should I target?');
  assert.equal(h.calls[0].meta.sessionId, 'session-q');
});

test('disabled statuses are filtered by config', async () => {
  const h = createHarness({ events: { completed: false, failed: true, awaitingInput: true, attention: true, cancelled: false } });
  const session = makeSession();
  h.notifier.onSessionEvent(session, event('turn/start', { turn: 1 }, { time: T0 }));
  h.notifier.onSessionEvent(session, turnEnd(1, { kind: 'completed' }, T0 + 60_000));
  await h.settle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.notifier.stats().bySkipReason['status:completed'], 1);
});

test('subagent sessions are filtered unless opted in', async () => {
  const sub = makeSession('sub-1', { origin: 'subagent' });

  const quiet = createHarness();
  quiet.notifier.onSessionEvent(sub, event('turn/start', { turn: 1 }, { time: T0 }));
  quiet.notifier.onSessionEvent(sub, turnEnd(1, { kind: 'completed' }, T0 + 60_000));
  await quiet.settle();
  assert.equal(quiet.calls.length, 0);
  assert.equal(quiet.notifier.stats().bySkipReason['subagent-session'], 1);

  const loud = createHarness({ includeSubagents: true });
  loud.notifier.onSessionEvent(sub, event('turn/start', { turn: 1 }, { time: T0 }));
  loud.notifier.onSessionEvent(sub, turnEnd(1, { kind: 'completed' }, T0 + 60_000));
  await loud.settle();
  assert.equal(loud.calls.length, 1);
  assert.equal(loud.calls[0].meta.isSubagent, true);
});

test('a repeated signal inside the dedupe window is collapsed', async () => {
  const h = createHarness();
  const session = makeSession();
  const end = turnEnd(1, { kind: 'completed' }, T0 + 60_000);
  h.notifier.onSessionEvent(session, event('turn/start', { turn: 1 }, { time: T0 }));

  h.notifier.onSessionEvent(session, end);
  h.notifier.onSessionEvent(session, { ...end, seq: 2 });
  await h.settle();

  assert.equal(h.calls.length, 1);
  assert.equal(h.notifier.stats().bySkipReason.duplicate, 1);
});

test('a live session title is attached to the notification', async () => {
  const h = createHarness();
  const session = makeSession();
  h.notifier.onSessionEvent(session, event('session/title', { title: 'Fix the login timeout', messageSeqs: [], source: 'llm' }));
  h.notifier.onSessionEvent(session, event('turn/start', { turn: 1 }, { time: T0 }));
  h.notifier.onSessionEvent(session, turnEnd(1, { kind: 'completed' }, T0 + 60_000));
  await h.settle();

  assert.equal(h.calls[0].meta.title, 'Fix the login timeout');
});

test('a session titled before activation still reports its title from a bounded replay', async () => {
  const h = createHarness();
  const session = {
    id: 'session-old',
    header: { id: 'session-old' },
    seq: 42,
    snapshotEvents(from, to) {
      assert.equal(to, 42);
      assert.equal(from, 0);
      return [
        { type: 'user/message', seq: 1 },
        { type: 'session/title', seq: 2, data: { title: 'Earlier titled task' } },
      ];
    },
  };
  h.notifier.onSessionEvent(session, event('turn/start', { turn: 1 }, { time: T0 }));
  h.notifier.onSessionEvent(session, turnEnd(1, { kind: 'completed' }, T0 + 60_000));
  await h.settle();

  assert.equal(h.calls[0].meta.title, 'Earlier titled task');
});

test('a broken title replay cannot lose the notification', async () => {
  const h = createHarness();
  const session = {
    id: 'session-bad',
    header: { id: 'session-bad' },
    seq: 5,
    snapshotEvents() {
      throw new Error('log unavailable');
    },
  };
  h.notifier.onSessionEvent(session, event('turn/start', { turn: 1 }, { time: T0 }));
  h.notifier.onSessionEvent(session, turnEnd(1, { kind: 'completed' }, T0 + 60_000));
  await h.settle();

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].meta.title, undefined);
});

test('a failing delivery is counted and does not escape', async () => {
  const h = createHarness({}, { deliver: async () => { throw new Error('webhook exploded'); } });
  const session = makeSession();
  h.notifier.onSessionEvent(session, event('turn/start', { turn: 1 }, { time: T0 }));
  h.notifier.onSessionEvent(session, turnEnd(1, { kind: 'completed' }, T0 + 60_000));
  await h.settle();
  await h.notifier.flush();

  assert.equal(h.notifier.stats().failed, 1);
  assert.equal(h.notifier.stats().delivered, 0);
});

test('malformed events never throw', async () => {
  const h = createHarness();
  const session = makeSession();
  for (const bad of [null, undefined, 42, 'turn/end', {}, { type: 'turn/end' }, { type: 'turn/end', data: null }]) {
    assert.doesNotThrow(() => h.notifier.onSessionEvent(session, bad));
  }
  assert.doesNotThrow(() => h.notifier.onSessionEvent(null, turnEnd(1, { kind: 'completed' }, T0)));
  assert.doesNotThrow(() => h.notifier.onUserQuestion(null, null));
  await h.settle();
});

test('flush delivers held notifications, dispose stops the notifier', async () => {
  const h = createHarness();
  const session = makeSession();
  h.notifier.onSessionEvent(session, event('approval/asked', { id: 'ap-5', toolName: 'pwsh' }));
  await h.notifier.flush();

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.status, 'awaiting-input');

  await h.notifier.dispose();
  h.notifier.onSessionEvent(session, turnEnd(1, { kind: 'error', error: { code: 'x', message: 'y' } }, T0 + 60_000));
  await h.settle();
  assert.equal(h.calls.length, 1, 'a disposed notifier must stay silent');
});

test('publish runs a synthetic signal through the normal pipeline', async () => {
  const h = createHarness();
  const signal = h.notifier.publish({ title: 'probe' });
  await h.settle();

  assert.equal(signal.status, 'completed');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].meta.title, 'probe');
});

test('stats reports counters, byStatus and pending state', async () => {
  const h = createHarness();
  const session = makeSession();
  h.notifier.onSessionEvent(session, event('turn/start', { turn: 1 }, { time: T0 }));
  h.notifier.onSessionEvent(session, turnEnd(1, { kind: 'completed' }, T0 + 60_000));
  h.notifier.onSessionEvent(session, event('approval/asked', { id: 'ap-6', toolName: 'pwsh' }));
  await h.settle();

  const stats = h.notifier.stats();
  assert.equal(stats.delivered, 1);
  assert.equal(stats.pending, 1);
  assert.equal(stats.byStatus.completed, 1);
  assert.equal(typeof stats.bySkipReason, 'object');
});

test('an unnormalized config is normalized on construction', () => {
  const notifier = new Notifier({ config: { minDurationMs: -5, webhooks: [{ url: 'not-a-url' }] } });
  assert.equal(notifier.config.minDurationMs, 0);
  assert.deepEqual(notifier.config.webhooks, []);
  assert.equal(notifier.config.events.failed, true);
  assert.equal(notifier.config.events.cancelled, false);
});

test('normalizeConfig keeps a valid webhook and drops an invalid one', () => {
  const config = normalizeConfig({
    webhooks: [
      { name: 'ok', type: 'telegram', url: 'https://api.telegram.org/bot1:x/sendMessage', chatId: 12345 },
      { name: 'bad', url: 'ftp://nope' },
      'nonsense',
    ],
  });
  assert.equal(config.webhooks.length, 1);
  assert.equal(config.webhooks[0].chatId, '12345');
  assert.equal(config.webhooks[0].name, 'ok');
});

test('a webhook defaults to enabled and can be switched off individually', () => {
  const config = normalizeConfig({
    webhooks: [
      { name: 'default-on', url: 'https://example.com/a' },
      { name: 'explicit-on', url: 'https://example.com/b', enabled: true },
      { name: 'off', url: 'https://example.com/c', enabled: false },
      // Anything that is not exactly `true` is off, so a typo cannot silently arm a target.
      { name: 'stringy', url: 'https://example.com/d', enabled: 'yes' },
    ],
  });

  assert.deepEqual(
    config.webhooks.map((entry) => [entry.name, entry.enabled]),
    [['default-on', true], ['explicit-on', true], ['off', false], ['stringy', false]],
  );
});

test('a header value containing CRLF is rejected', () => {
  const config = normalizeConfig({
    webhooks: [{ url: 'https://example.com/hook', headers: { 'x-a': 'ok', 'x-b': 'bad\r\nInjected: 1' } }],
  });
  assert.deepEqual(config.webhooks[0].headers, { 'x-a': 'ok' });
});

test('locale and logLevel are accepted case-insensitively and stored lower-cased', () => {
  // These two identifiers reach the host as hand-edited YAML far more often than from
  // the settings panel, and the panel displays them lower-cased. A case-sensitive test
  // here made the two halves disagree: the panel showed `silent` while the host ran at
  // `info`, and the next Save silently rewrote the value the user was looking at.
  for (const [raw, expected] of [['SILENT', 'silent'], ['Info', 'info'], ['  WARN  ', 'warn'], ['Error', 'error']]) {
    assert.equal(normalizeConfig({ logLevel: raw }).logLevel, expected, `logLevel ${JSON.stringify(raw)}`);
  }
  for (const [raw, expected] of [['ZH', 'zh'], ['EN', 'en'], [' Auto ', 'auto']]) {
    assert.equal(normalizeConfig({ locale: raw }).locale, expected, `locale ${JSON.stringify(raw)}`);
  }

  // The canonical form is a fixed point: normalizing twice cannot move the value again,
  // which is what makes "the panel shows what the host runs" true after a Save.
  const once = normalizeConfig({ logLevel: 'SILENT', locale: 'ZH' });
  assert.equal(once.logLevel, 'silent');
  assert.equal(once.locale, 'zh');
  assert.equal(normalizeConfig(once).logLevel, 'silent');
  assert.equal(normalizeConfig(once).locale, 'zh');
});

test('an unrecognised locale or logLevel still falls back to its own default', () => {
  for (const raw of ['loud', 'verbose', 'de-DE', 'zh-CN', '', '   ', 42, null, true, {}, [], ['info']]) {
    assert.equal(normalizeConfig({ logLevel: raw }).logLevel, 'info', `logLevel ${JSON.stringify(raw)}`);
    assert.equal(normalizeConfig({ locale: raw }).locale, 'auto', `locale ${JSON.stringify(raw)}`);
  }
  // The two sets stay separate: accepting one identifier's case must not let the other
  // identifier's words through.
  assert.equal(normalizeConfig({ logLevel: 'ZH' }).logLevel, 'info', 'a locale is not a log level');
  assert.equal(normalizeConfig({ locale: 'silent' }).locale, 'auto', 'a log level is not a locale');
});

test('the dedupe cache stays bounded without evicting live keys', async () => {
  // 600 distinct signals 10ms apart is 6s of history against a 1s dedupe window, which is
  // what exercises the pruning policy. It must neither grow with the whole session nor be
  // flushed, because a flushed cache would let a repeated signal notify twice.
  const h = createHarness({ minDurationMs: 0, dedupeWindowMs: 1000 });
  const session = makeSession();

  for (let turn = 1; turn <= 600; turn += 1) {
    const at = T0 + turn * 10;
    h.setNow(at);
    h.notifier.onSessionEvent(session, turnEnd(turn, { kind: 'completed' }, at));
  }
  await h.settle();

  const stats = h.notifier.stats();
  assert.equal(stats.delivered, 600);
  assert.ok(stats.dedupeEntries < 600, `dedupe cache grew unbounded: ${stats.dedupeEntries}`);
  assert.ok(stats.dedupeEntries >= 50, `dedupe cache was over-pruned: ${stats.dedupeEntries}`);

  const before = h.calls.length;
  h.setNow(T0 + 6_005);
  h.notifier.onSessionEvent(session, turnEnd(600, { kind: 'completed' }, T0 + 6_005));
  await h.settle();

  assert.equal(h.calls.length, before, 'a key inside the window must still suppress a duplicate');
  assert.equal(h.notifier.stats().bySkipReason.duplicate, 1);
});
