#!/usr/bin/env node
/**
 * End-to-end self-test.
 *
 * Drives the real classification -> formatting -> payload -> HTTP pipeline against a loopback
 * receiver, and (unless `--no-desktop`) fires the real native notification path once.
 *
 *   node tools/selftest.mjs                 # zh notification, desktop + webhook
 *   node tools/selftest.mjs --en            # English
 *   node tools/selftest.mjs --no-desktop    # webhook only, nothing pops up
 *   node tools/selftest.mjs --desktop-only  # no receiver, only the popup
 *
 * Exits non-zero when an expectation fails, so it doubles as a smoke test.
 */
import http from 'node:http';

import { createDeliver } from '../plugin.js';
import { normalizeConfig } from '../lib/config.js';
import { Notifier } from '../lib/dispatch.js';

const argv = new Set(process.argv.slice(2));
const useDesktop = !argv.has('--no-desktop');
const useWebhook = !argv.has('--desktop-only');
const locale = argv.has('--en') ? 'en' : 'zh';

const received = [];

function startReceiver() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { unparsed: raw };
        }
        received.push({ url: request.url, body: parsed });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = useWebhook ? await startReceiver() : undefined;
const port = server?.address()?.port;

const config = normalizeConfig({
  locale,
  desktop: { enabled: useDesktop, sound: false },
  // The real default gate, so step 4's 2s turn is genuinely suppressed while step 2's 8s
  // failure still gets through — that asymmetry is a documented rule, not an accident.
  minDurationMs: 10_000,
  // Keep the real debounce: the "resolved before it notified" case below only holds
  // because a held awaiting-input notification can be cancelled. `flush()` fires the
  // held ones we do want.
  awaitingInputDelayMs: 2_500,
  logDeliveries: true,
  webhooks: useWebhook
    ? [
        { name: 'local-generic', type: 'generic', url: `http://127.0.0.1:${port}/generic` },
        { name: 'local-feishu', type: 'feishu', url: `http://127.0.0.1:${port}/feishu` },
      ]
    : [],
});

/** Record what each delivery actually reported, so a failed toast cannot pass silently. */
const outcomes = [];
const realDeliver = createDeliver(config);
const deliver = async (signal, notification, meta) => {
  const outcome = await realDeliver(signal, notification, meta);
  outcomes.push({ status: signal.status, outcome });
  return outcome;
};

const notifier = new Notifier({
  config,
  deliver,
  log: (level, message) => console.log(`  [${level}] ${message}`),
});

const t0 = Date.now();
const session = { id: 'session-selftest', header: { id: 'session-selftest', cwd: process.cwd() }, seq: 0 };

console.log(`notify-hook self-test (locale=${locale}, desktop=${useDesktop}, webhook=${useWebhook})`);

console.log('\n1. session title + a completed 4m12s turn');
notifier.onSessionEvent(session, { type: 'session/title', seq: 1, time: t0, data: { title: '修复登录超时 / fix login timeout', messageSeqs: [], source: 'llm' } });
notifier.onSessionEvent(session, { type: 'turn/start', seq: 2, time: t0, data: { turn: 1 } });
notifier.onSessionEvent(session, { type: 'turn/end', seq: 3, time: t0 + 252_000, data: { turn: 1, reason: { kind: 'completed' } } });
await notifier.flush();
await sleep(useDesktop ? 1500 : 150);

console.log('\n2. a failed turn');
notifier.onSessionEvent(session, { type: 'turn/start', seq: 4, time: t0, data: { turn: 2 } });
notifier.onSessionEvent(session, { type: 'turn/end', seq: 5, time: t0 + 8_000, data: { turn: 2, reason: { kind: 'error', error: { code: 'rate_limit', message: 'Rate limit exceeded, retry later' } } } });
await notifier.flush();
await sleep(useDesktop ? 1500 : 150);

console.log('\n3. a permission prompt that stays open');
notifier.onSessionEvent(session, { type: 'approval/asked', seq: 6, time: t0, data: { id: 'ap-selftest', toolName: 'pwsh' } });
await notifier.flush();
await sleep(useDesktop ? 1500 : 150);

console.log('\n4. two silent cases: an answered prompt, and a turn below the duration threshold');
notifier.onSessionEvent(session, { type: 'approval/asked', seq: 7, time: t0, data: { id: 'ap-quiet', toolName: 'pwsh' } });
notifier.onSessionEvent(session, { type: 'approval/decided', seq: 8, time: t0, data: { id: 'ap-quiet', outcome: { kind: 'allowed' } } });
notifier.onSessionEvent(session, { type: 'turn/start', seq: 9, time: t0, data: { turn: 3 } });
notifier.onSessionEvent(session, { type: 'turn/end', seq: 10, time: t0 + 2_000, data: { turn: 3, reason: { kind: 'completed' } } });
await notifier.flush();
await sleep(100);

const silenced = notifier.stats().bySkipReason;
console.log(`   silenced: ${JSON.stringify(silenced)}`);

const failures = [];

// The silencing rules are half the value of this plugin, so they are asserted, not assumed.
if (silenced['resolved-before-notify'] !== 1) {
  failures.push(`expected the answered prompt to be silenced, got ${JSON.stringify(silenced)}`);
}
if (silenced['below-min-duration'] !== 1) {
  failures.push(`expected the 2s turn to be silenced by minDurationMs, got ${JSON.stringify(silenced)}`);
}
const statuses = received.map((entry, index) => `${index}:${entry.url}:${entry.body?.event ?? entry.body?.msg_type ?? entry.body?.msgtype ?? '?'}`);
console.log(`\nreceiver saw ${received.length} POST(s): ${statuses.join(' | ') || '(none)'}`);
console.log(`stats: ${JSON.stringify(notifier.stats())}`);

if (useWebhook) {
  // 3 announcements x 2 targets
  if (received.length !== 6) failures.push(`expected 6 webhook deliveries (3 events x 2 targets), received ${received.length}`);
  const generic = received.filter((entry) => entry.url === '/generic');
  const feishu = received.filter((entry) => entry.url === '/feishu');
  if (generic.length !== 3) failures.push(`expected 3 generic bodies, received ${generic.length}`);
  if (feishu.length !== 3) failures.push(`expected 3 feishu bodies, received ${feishu.length}`);
  const order = generic.map((entry) => entry.body?.event);
  if (JSON.stringify(order) !== JSON.stringify(['completed', 'failed', 'awaiting-input'])) {
    failures.push(`unexpected generic event order: ${JSON.stringify(order)}`);
  }
  if (feishu.some((entry) => entry.body?.msg_type !== 'text' || typeof entry.body?.content?.text !== 'string')) {
    failures.push('a feishu body is not { msg_type: "text", content: { text } }');
  }
  if (!generic[0]?.body?.text?.includes('修复登录超时') && locale === 'zh') {
    failures.push('the Chinese notification lost its session title');
  }
  if (generic[0]?.body?.durationMs !== 252_000) {
    failures.push(`expected durationMs 252000, got ${generic[0]?.body?.durationMs}`);
  }
}

const desktopResults = outcomes.map((entry) => entry.outcome?.desktop).filter(Boolean);
if (useDesktop) {
  if (desktopResults.length !== 3) {
    failures.push(`expected 3 desktop attempts, got ${desktopResults.length}`);
  }
  for (const result of desktopResults) {
    if (result.ok !== true) failures.push(`desktop delivery failed (${result.nativeKind ?? result.kind}): ${result.error}`);
  }
  console.log(`desktop: ${desktopResults.map((r) => `${r.nativeKind ?? '?'}=${r.ok ? 'ok' : r.error}`).join(', ') || '(none)'}`);
}

await notifier.dispose();
server?.close();

if (failures.length) {
  console.error('\nSELFTEST FAILED');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('\nSELFTEST PASSED');
