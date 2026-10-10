/**
 * Tests for lib/payloads.js (owner B).
 * Pure and injected only: no network, no filesystem, no timers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { TARGET_TYPES, PayloadError, detectTargetType, buildRequest, redactUrl } from '../lib/payloads.js';

const MAX_BODY_BYTES = 64 * 1024;

const URLS = {
  feishu: 'https://open.feishu.cn/open-apis/bot/v2/hook/9f8a-7b6c-5d4e',
  wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=KEY-9f8a',
  telegram: 'https://api.telegram.org/bot123456:SECRET/sendMessage',
  discord: 'https://discord.com/api/webhooks/123456789/TOKEN-XYZ',
  slack: 'https://hooks.slack.com/services/T00000000/B00000000/SECRETKEY',
  generic: 'https://example.com/notify',
};

const SIGNAL = {
  status: 'failed',
  at: 1700000000000,
  toolName: 'Bash',
  errorCode: 'E_LLM',
  errorMessage: 'socket hang up',
};

const META = {
  sessionId: 'sess-1',
  title: 'Fix login',
  cwd: 'E:\\work\\proj',
  durationMs: 133000,
  signal: SIGNAL,
};

/** @returns {object} a plausible `formatNotification` result. */
function makeNotification(overrides = {}) {
  const title = '❌ Task failed';
  const body = 'Fix login\nproj\nE_LLM: socket hang up\nElapsed 2m13s\nsession-c4460152…';
  return {
    title,
    body,
    level: 'error',
    tag: 'dsh:failed:sess-1',
    statusLabel: 'Task failed',
    text: `${title}\n${body}`,
    ...overrides,
  };
}

/** @param {string} body */
function parse(body) {
  return JSON.parse(body);
}

/* ------------------------------------------------------------------ *
 * module surface
 * ------------------------------------------------------------------ */

test('TARGET_TYPES and PayloadError match the contract', () => {
  assert.deepEqual([...TARGET_TYPES], ['auto', 'generic', 'feishu', 'wecom', 'telegram', 'discord', 'slack']);

  const error = new PayloadError('nope');
  assert.ok(error instanceof Error);
  assert.ok(error instanceof PayloadError);
  assert.equal(error.name, 'PayloadError');
  assert.equal(error.message, 'nope');
});

/* ------------------------------------------------------------------ *
 * detectTargetType
 * ------------------------------------------------------------------ */

test('detectTargetType sniffs all five providers and falls back to generic', () => {
  const cases = [
    ['https://open.feishu.cn/open-apis/bot/v2/hook/abc', 'feishu'],
    ['https://open.feishu.cn/open-apis/bot/hook/abc', 'feishu'],
    ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc', 'wecom'],
    ['https://api.telegram.org/bot123:SECRET/sendMessage', 'telegram'],
    ['https://discord.com/api/webhooks/1/TOKEN', 'discord'],
    ['https://discordapp.com/api/webhooks/1/TOKEN', 'discord'],
    ['https://ptb.discord.com/api/webhooks/1/TOKEN', 'discord'],
    ['https://hooks.slack.com/services/T/B/X', 'slack'],
    ['https://example.com/hook', 'generic'],
    ['https://hooks.example.com/notify', 'generic'],
    ['not a url', 'generic'],
    ['', 'generic'],
    [undefined, 'generic'],
    [null, 'generic'],
    [42, 'generic'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(detectTargetType(url), expected, `${String(url)} -> ${expected}`);
  }
});

/* ------------------------------------------------------------------ *
 * exact wire formats
 * ------------------------------------------------------------------ */

test('feishu body uses msg_type/content.text', () => {
  const notification = makeNotification();
  const request = buildRequest({ url: URLS.feishu }, notification);
  assert.equal(request.method, 'POST');
  assert.equal(request.url, URLS.feishu);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(parse(request.body), { msg_type: 'text', content: { text: notification.text } });
});

test('wecom body uses msgtype/text.content', () => {
  const notification = makeNotification();
  const request = buildRequest({ url: URLS.wecom }, notification);
  assert.deepEqual(parse(request.body), { msgtype: 'text', text: { content: notification.text } });
  assert.equal(request.headers['content-type'], 'application/json');
});

test('telegram body uses chat_id/text/disable_web_page_preview', () => {
  const notification = makeNotification();
  const request = buildRequest({ url: URLS.telegram, chatId: '-1001234567890' }, notification);
  assert.deepEqual(parse(request.body), {
    chat_id: '-1001234567890',
    text: notification.text,
    disable_web_page_preview: true,
  });
  assert.equal(request.headers['content-type'], 'application/json');

  const numeric = buildRequest({ url: URLS.telegram, chatId: 123456789 }, notification);
  assert.equal(parse(numeric.body).chat_id, 123456789);
});

test('discord body uses content/username and clamps content to 1900 chars', () => {
  const notification = makeNotification();
  const request = buildRequest({ url: URLS.discord }, notification);
  assert.deepEqual(parse(request.body), { content: notification.text, username: 'DSH' });
  assert.equal(request.headers['content-type'], 'application/json');

  const long = buildRequest({ url: URLS.discord }, makeNotification({ text: 'x'.repeat(5000) }));
  const parsed = parse(long.body);
  assert.equal(parsed.content.length, 1900);
  assert.equal(parsed.username, 'DSH');
});

test('slack body uses text', () => {
  const notification = makeNotification();
  const request = buildRequest({ url: URLS.slack }, notification);
  assert.deepEqual(parse(request.body), { text: notification.text });
  assert.equal(request.headers['content-type'], 'application/json');
});

test('generic body is the structured JSON envelope', () => {
  const notification = makeNotification();
  const request = buildRequest({ url: URLS.generic }, notification, META);
  assert.deepEqual(parse(request.body), {
    source: 'dsh-notification-hook',
    event: 'failed',
    statusLabel: 'Task failed',
    title: '❌ Task failed',
    body: notification.body,
    text: notification.text,
    sessionId: 'sess-1',
    sessionTitle: 'Fix login',
    cwd: 'E:\\work\\proj',
    durationMs: 133000,
    toolName: 'Bash',
    errorCode: 'E_LLM',
    errorMessage: 'socket hang up',
    at: '2023-11-14T22:13:20.000Z',
  });
  assert.equal(request.headers['content-type'], 'application/json');
});

test('generic body tolerates missing meta, signal and timestamps', () => {
  const bare = parse(buildRequest({ url: URLS.generic }, makeNotification({ tag: undefined }), {}).body);
  assert.equal(bare.event, 'unknown');
  assert.equal(bare.sessionId, '');
  assert.equal(bare.sessionTitle, '');
  assert.equal(bare.cwd, '');
  assert.equal(bare.durationMs, null);
  assert.equal(bare.toolName, '');
  assert.equal(bare.at, '1970-01-01T00:00:00.000Z');

  // Without a signal, the status is still recoverable from the notification tag.
  const fromTag = parse(buildRequest({ url: URLS.generic }, makeNotification(), {}).body);
  assert.equal(fromTag.event, 'failed');

  const inline = parse(
    buildRequest({ url: URLS.generic }, makeNotification(), { sessionId: 's2', status: 'completed', toolName: 'Bash' })
      .body,
  );
  assert.equal(inline.event, 'completed');
  assert.equal(inline.toolName, 'Bash');

  const fromParts = parse(
    buildRequest({ url: URLS.generic }, { title: 'A', body: 'B', statusLabel: 'S' }, { signal: { status: 'completed' } })
      .body,
  );
  assert.equal(fromParts.text, 'A\nB');
});

test('every resolved type emits JSON with a JSON content type', () => {
  const targets = [
    { url: URLS.feishu },
    { url: URLS.wecom },
    { url: URLS.telegram, chatId: '1' },
    { url: URLS.discord },
    { url: URLS.slack },
    { url: URLS.generic },
  ];
  for (const target of targets) {
    const request = buildRequest(target, makeNotification(), META);
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.method, 'POST');
    assert.ok(parse(request.body) !== null);
    assert.ok(Buffer.byteLength(request.body, 'utf8') <= MAX_BODY_BYTES);
  }
});

/* ------------------------------------------------------------------ *
 * type resolution
 * ------------------------------------------------------------------ */

test('auto (and missing) type resolves through detection', () => {
  const detected = parse(buildRequest({ url: URLS.slack, type: 'auto' }, makeNotification()).body);
  assert.deepEqual(detected, { text: makeNotification().text });

  const missing = parse(buildRequest({ url: URLS.feishu }, makeNotification()).body);
  assert.equal(missing.msg_type, 'text');
});

test('an explicit type overrides detection', () => {
  const asSlack = parse(buildRequest({ url: URLS.generic, type: 'slack' }, makeNotification()).body);
  assert.deepEqual(asSlack, { text: makeNotification().text });

  const asGeneric = buildRequest({ url: URLS.slack, type: 'generic' }, makeNotification(), META);
  assert.equal(parse(asGeneric.body).source, 'dsh-notification-hook');

  const asFeishu = parse(buildRequest({ url: URLS.generic, type: 'feishu' }, makeNotification()).body);
  assert.equal(asFeishu.msg_type, 'text');

  const upper = parse(buildRequest({ url: URLS.generic, type: 'WECOM' }, makeNotification()).body);
  assert.equal(upper.msgtype, 'text');
});

test('an unknown explicit type throws PayloadError', () => {
  for (const type of ['matrix', 'teams', 'slackk', 'nope']) {
    assert.throws(
      () => buildRequest({ url: URLS.generic, type }, makeNotification()),
      (error) => error instanceof PayloadError && error.name === 'PayloadError' && error.message.includes(type),
      `type=${type} must throw PayloadError`,
    );
  }
  assert.throws(() => buildRequest({ url: 'not a url', type: 'matrix' }, makeNotification()), PayloadError);
});

test('a missing url throws PayloadError', () => {
  for (const target of [undefined, null, {}, { url: '' }, { url: '   ' }, { url: 42 }]) {
    assert.throws(() => buildRequest(target, makeNotification()), PayloadError);
  }
});

test('telegram without a usable chatId throws PayloadError', () => {
  for (const chatId of [undefined, null, '', '   ', Number.NaN, {}, [], false]) {
    assert.throws(
      () => buildRequest({ url: URLS.telegram, chatId }, makeNotification()),
      PayloadError,
      `chatId=${String(chatId)} must throw`,
    );
  }
  assert.doesNotThrow(() => buildRequest({ url: URLS.telegram, chatId: '@channel' }, makeNotification()));
});

/* ------------------------------------------------------------------ *
 * headers
 * ------------------------------------------------------------------ */

test('custom headers are merged and win, without duplicates', () => {
  const request = buildRequest(
    { url: URLS.slack, headers: { 'X-Token': 'abc', 'content-type': 'text/plain', 'X-Count': 3, 'X-Empty': null } },
    makeNotification(),
  );
  assert.equal(request.headers['content-type'], 'text/plain');
  assert.equal(request.headers['X-Token'], 'abc');
  assert.equal(request.headers['X-Count'], '3');
  assert.ok(!('X-Empty' in request.headers));
  assert.equal(
    Object.keys(request.headers).filter((key) => key.toLowerCase() === 'content-type').length,
    1,
  );

  const cased = buildRequest(
    { url: URLS.slack, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    makeNotification(),
  );
  assert.deepEqual(cased.headers, { 'Content-Type': 'application/json; charset=utf-8' });

  const untouched = buildRequest({ url: URLS.slack, headers: 'nope' }, makeNotification());
  assert.deepEqual(untouched.headers, { 'content-type': 'application/json' });
});

test('buildRequest does not mutate its inputs', () => {
  const target = Object.freeze({ url: URLS.generic, headers: Object.freeze({ 'X-Token': 'abc' }) });
  const notification = Object.freeze(makeNotification());
  const meta = Object.freeze({ ...META });
  const request = buildRequest(target, notification, meta);
  assert.equal(parse(request.body).text, notification.text);
  assert.equal(notification.body, makeNotification().body);
});

/* ------------------------------------------------------------------ *
 * 64 KiB cap
 * ------------------------------------------------------------------ */

test('the body cap keeps valid JSON and preserves other fields', () => {
  const huge = 'a'.repeat(200_000);
  const notification = makeNotification({ text: huge });
  const request = buildRequest({ url: URLS.generic }, notification, META);

  assert.ok(Buffer.byteLength(request.body, 'utf8') <= MAX_BODY_BYTES);
  const parsed = parse(request.body);
  assert.equal(parsed.source, 'dsh-notification-hook');
  assert.equal(parsed.sessionId, 'sess-1');
  assert.equal(parsed.title, notification.title);
  assert.ok(parsed.text.length < huge.length);
  assert.ok(parsed.text.endsWith('…'));
  assert.ok(parsed.text.startsWith('aaa'));
});

test('the cap also shrinks nested text fields', () => {
  const huge = '中'.repeat(100_000);
  const request = buildRequest({ url: URLS.feishu }, makeNotification({ text: huge }));

  assert.ok(Buffer.byteLength(request.body, 'utf8') <= MAX_BODY_BYTES);
  const parsed = parse(request.body);
  assert.equal(parsed.msg_type, 'text');
  assert.equal(parsed.content.text.endsWith('…'), true);
  assert.ok(parsed.content.text.length < huge.length);
});

test('the cap never splits a surrogate pair', () => {
  const request = buildRequest({ url: URLS.generic }, makeNotification({ text: '😀'.repeat(40_000) }), META);

  assert.ok(Buffer.byteLength(request.body, 'utf8') <= MAX_BODY_BYTES);
  const parsed = parse(request.body);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(parsed.text), 'no lone high surrogate');
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(parsed.text), 'no lone low surrogate');
});

test('oversized payloads stay valid JSON for every provider', () => {
  const huge = 'x'.repeat(300_000);
  const targets = [
    { url: URLS.feishu },
    { url: URLS.wecom },
    { url: URLS.telegram, chatId: '1' },
    { url: URLS.discord },
    { url: URLS.slack },
    { url: URLS.generic },
  ];
  for (const target of targets) {
    const request = buildRequest(target, makeNotification({ text: huge }), META);
    assert.ok(Buffer.byteLength(request.body, 'utf8') <= MAX_BODY_BYTES, `${target.url} body size`);
    assert.doesNotThrow(() => JSON.parse(request.body), `${target.url} body must stay valid JSON`);
  }
});

/* ------------------------------------------------------------------ *
 * redactUrl
 * ------------------------------------------------------------------ */

test('redactUrl never leaks a provider secret', () => {
  const cases = [
    ['https://api.telegram.org/bot123456:SECRET/sendMessage', 'SECRET', 'https://api.telegram.org'],
    ['https://api.telegram.org/bot987654321:AAHbcdEFGH/sendMessage', 'AAHbcdEFGH', 'https://api.telegram.org'],
    ['https://discord.com/api/webhooks/123456789/TOKEN-XYZ', 'TOKEN-XYZ', 'https://discord.com'],
    ['https://discordapp.com/api/webhooks/123/TOKEN-XYZ', 'TOKEN-XYZ', 'https://discordapp.com'],
    ['https://hooks.slack.com/services/T00000000/B00000000/SECRETKEY', 'SECRETKEY', 'https://hooks.slack.com'],
    ['https://open.feishu.cn/open-apis/bot/v2/hook/FEISHU-KEY-1234', 'FEISHU-KEY-1234', 'https://open.feishu.cn'],
    ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=WECOM-KEY-9999', 'WECOM-KEY-9999', 'https://qyapi.weixin.qq.com'],
  ];
  for (const [url, secret, origin] of cases) {
    const redacted = redactUrl(url);
    assert.ok(!redacted.includes(secret), `${url} leaked ${secret} as ${redacted}`);
    assert.ok(redacted.startsWith(origin), `${url} -> ${redacted} should keep ${origin}`);
  }
});

test('redactUrl keeps only the origin and a redaction marker', () => {
  assert.equal(redactUrl('https://example.com/hook/secret'), 'https://example.com/…');
  assert.equal(redactUrl('https://example.com/hook'), 'https://example.com/…');
  assert.equal(redactUrl('https://example.com/'), 'https://example.com');
  assert.equal(redactUrl('https://example.com'), 'https://example.com');
  assert.equal(redactUrl('http://127.0.0.1:8080/api/v1/send'), 'http://127.0.0.1:8080/…');
  assert.equal(redactUrl(URLS.slack), 'https://hooks.slack.com/…');
  assert.equal(redactUrl(URLS.discord), 'https://discord.com/…');
  assert.equal(redactUrl(URLS.wecom), 'https://qyapi.weixin.qq.com/…');
  assert.equal(redactUrl(URLS.feishu), 'https://open.feishu.cn/…');
});

test('redactUrl drops query strings, fragments and credentials', () => {
  assert.ok(!redactUrl('https://example.com/hook?token=SUPERSECRET#frag').includes('SUPERSECRET'));
  assert.ok(!redactUrl('https://example.com/hook?token=SUPERSECRET#frag').includes('frag'));
  assert.equal(redactUrl('https://user:SUPERSECRET@example.com/hook'), 'https://example.com/…');
  assert.equal(redactUrl('https://example.com/hook?a=1&b=2'), 'https://example.com/…');
});

test('redactUrl masks long opaque first segments and unparseable input', () => {
  assert.equal(redactUrl('https://example.com/AbCdEf0123456789AbCdEf0123456789'), 'https://example.com/…');
  assert.equal(redactUrl('https://example.com/xoxb-1234567890-abcdef'), 'https://example.com/…');
  assert.equal(redactUrl('not a url'), '<invalid-url>');
  assert.equal(redactUrl('api.telegram.org/bot123:SECRET/sendMessage'), '<invalid-url>');
  assert.equal(redactUrl('https://user:REVIEW_SECRET@invalid host/hook'), '<invalid-url>');
  assert.equal(redactUrl(''), '');
  assert.equal(redactUrl(undefined), '');
  assert.equal(redactUrl(42), '');
  assert.doesNotThrow(() => redactUrl({ toString: () => 'https://example.com/a/b' }));
});
