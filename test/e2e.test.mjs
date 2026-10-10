// Integration test: real loopback HTTP, the real delivery pipeline, no host process.
// This is the layer between the unit suites and the live profile install.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createDeliver } from '../plugin.js';
import { normalizeConfig } from '../lib/config.js';
import { Notifier } from '../lib/dispatch.js';

const T0 = 1_700_000_000_000;

/** Start a receiver that records every request body; resolves once it is listening. */
function startReceiver() {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = { unparsed: raw };
      }
      received.push({ url: request.url, headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a completed, a failed and an open permission prompt reach every target', async (t) => {
  const { server, received, port } = await startReceiver();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const config = normalizeConfig({
    locale: 'zh',
    desktop: { enabled: false },
    minDurationMs: 10_000,
    awaitingInputDelayMs: 0,
    webhooks: [
      { name: 'generic', type: 'generic', url: `http://127.0.0.1:${port}/generic` },
      { name: 'feishu', type: 'feishu', url: `http://127.0.0.1:${port}/feishu` },
      { name: 'discord', type: 'discord', url: `http://127.0.0.1:${port}/discord` },
    ],
  });

  const notifier = new Notifier({
    config,
    deliver: createDeliver(config),
    log() {},
    now: () => T0,
  });
  t.after(() => notifier.dispose());

  const session = { id: 'session-e2e', header: { id: 'session-e2e', cwd: 'E:\\work\\dhs-skill' }, seq: 0 };
  const send = (type, data, seq, time = T0) => notifier.onSessionEvent(session, { type, seq, time, data });

  send('session/title', { title: '修复登录超时', messageSeqs: [], source: 'llm' }, 1);
  send('turn/start', { turn: 1 }, 2);
  send('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3, T0 + 252_000);
  await notifier.flush();

  send('turn/start', { turn: 2 }, 4);
  send('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'rate_limit', message: 'slow down' } } }, 5, T0 + 5_000);
  await notifier.flush();

  send('approval/asked', { id: 'ap-e2e', toolName: 'pwsh' }, 6);
  await notifier.flush();
  await settle();

  assert.equal(received.length, 9, `expected 3 signals x 3 targets, got ${received.length}`);

  const generic = received.filter((entry) => entry.url === '/generic').map((entry) => entry.body);
  const feishu = received.filter((entry) => entry.url === '/feishu').map((entry) => entry.body);
  const discord = received.filter((entry) => entry.url === '/discord').map((entry) => entry.body);

  assert.deepEqual(generic.map((body) => body.event), ['completed', 'failed', 'awaiting-input']);

  // Generic: the full machine-readable contract.
  assert.equal(generic[0].source, 'dsh-notification-hook');
  assert.equal(generic[0].sessionId, 'session-e2e');
  assert.equal(generic[0].sessionTitle, '修复登录超时');
  assert.equal(generic[0].durationMs, 252_000);
  assert.match(generic[0].text, /修复登录超时/);
  assert.match(generic[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(generic[1].errorCode, 'rate_limit');
  assert.equal(generic[1].errorMessage, 'slow down');
  assert.equal(generic[2].toolName, 'pwsh');

  // Feishu and Discord must receive their own provider envelopes, not the generic one.
  for (const body of feishu) {
    assert.equal(body.msg_type, 'text');
    assert.equal(typeof body.content.text, 'string');
    assert.equal(body.event, undefined);
  }
  for (const body of discord) {
    assert.equal(typeof body.content, 'string');
    assert.ok(body.content.length > 0);
    assert.equal(body.event, undefined);
  }

  // Every request must be a JSON POST.
  for (const entry of received) {
    assert.match(entry.headers['content-type'] ?? '', /application\/json/);
  }
});

test('the silencing rules hold end to end', async (t) => {
  const { server, received, port } = await startReceiver();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const config = normalizeConfig({
    locale: 'en',
    desktop: { enabled: false },
    minDurationMs: 10_000,
    awaitingInputDelayMs: 60_000,
    webhooks: [{ name: 'generic', type: 'generic', url: `http://127.0.0.1:${port}/generic` }],
  });
  const notifier = new Notifier({ config, deliver: createDeliver(config), log() {}, now: () => T0 });
  t.after(() => notifier.dispose());

  const session = { id: 'session-quiet', header: { id: 'session-quiet' }, seq: 0 };
  const send = (type, data, seq, time = T0) => notifier.onSessionEvent(session, { type, seq, time, data });

  // A 2s successful turn is below the threshold.
  send('turn/start', { turn: 1 }, 1);
  send('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2, T0 + 2_000);

  // A permission prompt that is answered straight away.
  send('approval/asked', { id: 'ap-quiet', toolName: 'pwsh' }, 3);
  send('approval/decided', { id: 'ap-quiet', outcome: { kind: 'allowed' } }, 4);

  // A forked turn is not a user-facing outcome.
  send('turn/end', { turn: 2, reason: { kind: 'forked' } }, 5, T0 + 60_000);

  await notifier.flush();
  await settle();

  assert.equal(received.length, 0, `expected no deliveries, got ${JSON.stringify(received.map((e) => e.body))}`);
  const stats = notifier.stats();
  assert.equal(stats.delivered, 0);
  assert.equal(stats.bySkipReason['below-min-duration'], 1);
  assert.equal(stats.bySkipReason['resolved-before-notify'], 1);
});

test('a target that returns 500 does not stop the healthy target', async (t) => {
  const healthy = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === '/broken') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{"error":"nope"}');
        return;
      }
      healthy.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const config = normalizeConfig({
    desktop: { enabled: false },
    minDurationMs: 0,
    retries: 0,
    webhooks: [
      { name: 'broken', type: 'generic', url: `http://127.0.0.1:${port}/broken` },
      { name: 'healthy', type: 'generic', url: `http://127.0.0.1:${port}/ok` },
    ],
  });
  // Failures still count as a "delivered" dispatch: the isolation is what is under test.
  const deliveries = [];
  const deliver = createDeliver(config);
  const notifier = new Notifier({
    config,
    now: () => T0,
    log() {},
    deliver: async (signal, notification, meta) => {
      const outcome = await deliver(signal, notification, meta);
      deliveries.push(outcome);
    },
  });
  t.after(() => notifier.dispose());

  notifier.publish({ title: 'isolation probe' });
  await notifier.flush();
  await settle();

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].webhooks.length, 2);
  assert.equal(deliveries[0].webhooks.find((entry) => entry.name === 'healthy').ok, true);
  assert.equal(deliveries[0].webhooks.find((entry) => entry.name === 'broken').ok, false);
  assert.equal(healthy.length, 1);
});

test('an unreachable target is reported, not thrown', async (t) => {
  const config = normalizeConfig({
    desktop: { enabled: false },
    minDurationMs: 0,
    retries: 0,
    timeoutMs: 1500,
    webhooks: [{ name: 'dead', type: 'generic', url: 'http://127.0.0.1:1/hook' }],
  });
  const deliver = createDeliver(config);
  const notification = { title: 't', body: 'b', text: 't\nb', level: 'info', tag: 'x', statusLabel: 'x' };
  const outcome = await deliver(
    { status: 'completed', at: T0, dedupeKey: 'k', eventType: 'turn/end' },
    notification,
    { sessionId: 's' },
  );

  assert.equal(outcome.webhooks.length, 1);
  assert.equal(outcome.webhooks[0].ok, false);
  assert.ok(outcome.webhooks[0].error, 'a transport failure must carry a reason');
});

test('a webhook URL secret never reaches the log', async () => {
  const lines = [];
  const config = normalizeConfig({
    desktop: { enabled: false },
    minDurationMs: 0,
    retries: 0,
    timeoutMs: 1200,
    webhooks: [
      { name: 'telegram', type: 'telegram', url: 'http://127.0.0.1:1/bot123456:SUPERSECRET/sendMessage', chatId: '1' },
    ],
  });
  const notifier = new Notifier({
    config,
    now: () => T0,
    deliver: createDeliver(config),
    log: (level, message) => lines.push(`${level} ${message}`),
  });
  notifier.publish({ title: 'secret probe' });
  await notifier.flush();

  const joined = lines.join('\n');
  assert.ok(joined.length > 0, 'the delivery outcome must be logged');
  assert.ok(!joined.includes('SUPERSECRET'), `secret leaked into the log:\n${joined}`);
});

test('host delivery logs redact malformed credential URLs and transport errors', async () => {
  const secret = 'REVIEW_SECRET';
  const raw = `https://user:${secret}@invalid host/hook`;
  const lines = [];
  const originalInfo = console.info;
  console.info = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    const config = normalizeConfig({
      desktop: { enabled: false },
      retries: 0,
      logDeliveries: true,
      webhooks: [{ name: 'malformed', type: 'generic', url: raw }],
    });
    const deliver = createDeliver(config);
    await deliver(
      { status: 'completed', at: T0, dedupeKey: 'malformed-log', eventType: 'turn/end' },
      { title: 'probe', body: 'probe', text: 'probe', level: 'info', tag: 'probe', statusLabel: 'completed' },
      { sessionId: 's' },
    );
  } finally {
    console.info = originalInfo;
  }

  const joined = lines.join('\n');
  assert.ok(joined.length > 0, 'the delivery outcome must be logged');
  assert.equal(joined.includes(secret), false, joined);
  assert.equal(joined.includes(raw), false, joined);
  assert.ok(joined.includes('<invalid-url>'), joined);
});

test('a switched-off target is never contacted while the others still are', async (t) => {
  // This is the "push to WeCom AND the desktop, each with its own switch" case: one target is
  // parked, one is live, and nothing extra is sent anywhere.
  const { server, received, port } = await startReceiver();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const config = normalizeConfig({
    desktop: { enabled: false },
    minDurationMs: 0,
    webhooks: [
      { name: 'live', type: 'generic', url: `http://127.0.0.1:${port}/live` },
      { name: 'parked', type: 'generic', url: `http://127.0.0.1:${port}/parked`, enabled: false },
    ],
  });

  const outcomes = [];
  const deliver = createDeliver(config);
  const notifier = new Notifier({
    config,
    now: () => T0,
    log() {},
    deliver: async (signal, notification, meta) => {
      const outcome = await deliver(signal, notification, meta);
      outcomes.push(outcome);
      return outcome;
    },
  });
  t.after(() => notifier.dispose());

  notifier.publish({ title: 'per-target switch' });
  await notifier.flush();
  await settle();

  assert.deepEqual(received.map((entry) => entry.url), ['/live']);
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0].webhooks.map((entry) => entry.name), ['live']);
  assert.equal(outcomes[0].webhooks[0].ok, true);
});
