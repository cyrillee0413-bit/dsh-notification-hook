/**
 * Tests for lib/format.js (owner B).
 * Pure and injected only: no network, no filesystem, no timers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LOCALES, resolveLocale, formatNotification } from '../lib/format.js';

const SESSION_ID = 'session-c4460152-e524-4956-8847-794332d5c235';
const SHORT_ID = 'session-c4460152…';

const STATUS_CASES = [
  { status: 'completed', level: 'info', emoji: '✅', zh: '任务完成', en: 'Task completed' },
  { status: 'failed', level: 'error', emoji: '❌', zh: '任务失败', en: 'Task failed' },
  { status: 'awaiting-input', level: 'warn', emoji: '⏳', zh: '等待输入', en: 'Waiting for input' },
  { status: 'attention', level: 'warn', emoji: '⚠️', zh: '需要关注', en: 'Needs attention' },
  { status: 'cancelled', level: 'info', emoji: '⛔', zh: '任务已取消', en: 'Task cancelled' },
];

/** @param {string} notification */
function lines(notification) {
  return notification.body.length ? notification.body.split('\n') : [];
}

test('LOCALES lists the supported locales', () => {
  assert.deepEqual([...LOCALES], ['zh', 'en']);
});

/* ------------------------------------------------------------------ *
 * resolveLocale
 * ------------------------------------------------------------------ */

test('resolveLocale honours explicit preferences', () => {
  assert.equal(resolveLocale('zh', { LANG: 'en_US.UTF-8' }), 'zh');
  assert.equal(resolveLocale('en', { DSH_LOCALE: 'zh-CN' }), 'en');
  assert.equal(resolveLocale('zh-CN', { LANG: 'en_US.UTF-8' }), 'zh');
  assert.equal(resolveLocale('EN_us', {}), 'en');
});

test('resolveLocale sniffs DSH_LOCALE, then LANG/LC_ALL/LC_MESSAGES', () => {
  assert.equal(resolveLocale('auto', { DSH_LOCALE: 'zh-CN' }), 'zh');
  assert.equal(resolveLocale('auto', { DSH_LOCALE: 'zh' }), 'zh');
  assert.equal(resolveLocale('auto', { LANG: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(resolveLocale('auto', { LC_ALL: 'zh_TW.UTF-8' }), 'zh');
  assert.equal(resolveLocale('auto', { LC_MESSAGES: 'zh' }), 'zh');
  assert.equal(resolveLocale('auto', { LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(resolveLocale('auto', { LANG: 'ja_JP.UTF-8' }), 'en');
  assert.equal(resolveLocale('auto', {}), 'en');
  assert.equal(resolveLocale('auto'), resolveLocale('auto', process.env));
});

test('resolveLocale follows the operating-system locale when DSH has no explicit preference', () => {
  assert.equal(resolveLocale('auto', {}, 'zh-CN'), 'zh');
  assert.equal(resolveLocale('auto', {}, 'en-SG'), 'en');
  assert.equal(resolveLocale('auto', { DSH_LOCALE: 'en' }, 'zh-CN'), 'en', 'an explicit DSH locale wins');
});

test('resolveLocale treats unknown locales and hostile env as en', () => {
  assert.equal(resolveLocale('fr', {}), 'en');
  assert.equal(resolveLocale('', {}), 'en');
  assert.equal(resolveLocale(undefined, {}), 'en');
  assert.equal(resolveLocale(null, null), 'en');
  assert.equal(resolveLocale(42, 'not-an-env'), 'en');
  assert.equal(resolveLocale('auto', { LANG: 123, DSH_LOCALE: null, LC_ALL: {} }), 'en');
});

/* ------------------------------------------------------------------ *
 * statuses and locales
 * ------------------------------------------------------------------ */

test('formatNotification renders every status in both locales', () => {
  for (const locale of LOCALES) {
    for (const entry of STATUS_CASES) {
      const notification = formatNotification(
        { status: entry.status, at: 1700000000000 },
        { sessionId: SESSION_ID, title: 'Fix login timeout' },
        { locale },
      );
      const label = locale === 'zh' ? entry.zh : entry.en;
      assert.equal(notification.statusLabel, label, `${locale}/${entry.status} label`);
      assert.equal(notification.title, `${entry.emoji} ${label}`, `${locale}/${entry.status} title`);
      assert.equal(notification.level, entry.level, `${locale}/${entry.status} level`);
      assert.equal(notification.tag, `dsh:${entry.status}:${SESSION_ID}`);
      assert.equal(notification.text, `${notification.title}\n${notification.body}`);
      assert.equal(notification.body.split('\n')[0], 'Fix login timeout');
      assert.equal(notification.body.split('\n').at(-1), SHORT_ID);
    }
  }
});

test('formatNotification treats an unknown locale like the system-controlled auto mode', () => {
  const unknown = formatNotification({ status: 'completed' }, {}, { locale: 'fr' });
  const automatic = formatNotification({ status: 'completed' }, {}, { locale: 'auto' });
  assert.equal(unknown.statusLabel, automatic.statusLabel);
  assert.equal(unknown.title, automatic.title);
});

/* ------------------------------------------------------------------ *
 * body composition
 * ------------------------------------------------------------------ */

test('body lines follow the documented order', () => {
  const signal = {
    status: 'failed',
    at: 1700000000000,
    errorCode: 'LLM_TIMEOUT',
    errorMessage: 'request timed out',
    toolName: 'Bash',
  };
  const meta = {
    sessionId: SESSION_ID,
    title: 'Fix login timeout',
    cwd: 'C:\\work\\app',
    durationMs: 133000,
  };

  const zh = formatNotification(signal, meta, { locale: 'zh' });
  assert.deepEqual(lines(zh), [
    'Fix login timeout',
    'app',
    'LLM_TIMEOUT: request timed out',
    '耗时 2m13s',
    SHORT_ID,
  ]);
  assert.equal(zh.text, `❌ 任务失败\n${zh.body}`);

  const en = formatNotification(signal, meta, { locale: 'en' });
  assert.deepEqual(lines(en), [
    'Fix login timeout',
    'app',
    'LLM_TIMEOUT: request timed out',
    'Elapsed 2m13s',
    SHORT_ID,
  ]);
});

test('project wins over cwd and both are reduced to a basename', () => {
  const fromCwd = formatNotification({ status: 'completed' }, { cwd: '/srv/apps/web/' }, { locale: 'en' });
  assert.deepEqual(lines(fromCwd), ['web']);

  const fromProject = formatNotification(
    { status: 'completed' },
    { cwd: 'C:\\work\\app', project: '/srv/apps/api' },
    { locale: 'en' },
  );
  assert.deepEqual(lines(fromProject), ['api']);
});

test('the session id line is omitted when it already served as the title', () => {
  const notification = formatNotification({ status: 'completed' }, { sessionId: SESSION_ID }, { locale: 'en' });
  assert.deepEqual(lines(notification), [SHORT_ID]);

  const short = formatNotification({ status: 'completed' }, { sessionId: 'sess-1' }, { locale: 'en' });
  assert.deepEqual(lines(short), ['sess-1']);
});

test('subagent sessions are marked on the title line', () => {
  const meta = { sessionId: SESSION_ID, title: 'Run build', isSubagent: true };
  assert.equal(lines(formatNotification({ status: 'completed' }, meta, { locale: 'zh' }))[0], 'Run build（子代理）');
  assert.equal(lines(formatNotification({ status: 'completed' }, meta, { locale: 'en' }))[0], 'Run build (subagent)');
  assert.equal(
    lines(formatNotification({ status: 'completed' }, { ...meta, title: undefined }, { locale: 'en' }))[0],
    `${SHORT_ID} (subagent)`,
  );

  const plain = formatNotification({ status: 'completed' }, { title: 'Run build' }, { locale: 'en' });
  assert.equal(lines(plain)[0], 'Run build');
});

test('status detail covers errors, questions, tool names and cancellation', () => {
  const failed = formatNotification(
    { status: 'failed', errorCode: 'E_LLM', errorMessage: 'socket hang up' },
    { sessionId: 'sess-1' },
    { locale: 'en' },
  );
  assert.ok(lines(failed).includes('E_LLM: socket hang up'));

  const messageOnly = formatNotification(
    { status: 'failed', errorMessage: 'socket hang up', toolName: 'Bash' },
    { sessionId: 'sess-1' },
    { locale: 'en' },
  );
  assert.ok(lines(messageOnly).includes('socket hang up'));
  assert.ok(!messageOnly.body.includes('Tool: Bash'));

  const codeOnly = formatNotification({ status: 'failed', errorCode: 'E_LLM' }, { sessionId: 'sess-1' }, { locale: 'en' });
  assert.ok(lines(codeOnly).includes('E_LLM'));

  const question = formatNotification(
    { status: 'awaiting-input', question: 'Which database?\nPostgres or MySQL?' },
    { sessionId: 'sess-1' },
    { locale: 'en' },
  );
  assert.ok(lines(question).includes('Which database? Postgres or MySQL?'));

  const tool = formatNotification({ status: 'awaiting-input', toolName: 'Bash' }, { sessionId: 'sess-1' }, { locale: 'en' });
  assert.ok(lines(tool).includes('Tool: Bash'));
  const zhTool = formatNotification({ status: 'awaiting-input', toolName: 'Bash' }, { sessionId: 'sess-1' }, { locale: 'zh' });
  assert.ok(lines(zhTool).includes('工具：Bash'));

  const cancelled = formatNotification({ status: 'cancelled', cancelKind: 'user' }, { sessionId: 'sess-1' }, { locale: 'en' });
  assert.ok(lines(cancelled).includes('Reason: user'));

  const noDetail = formatNotification({ status: 'completed' }, {}, { locale: 'en' });
  assert.equal(noDetail.body, '');
});

test('question text is truncated to 200 characters', () => {
  const notification = formatNotification(
    { status: 'awaiting-input', question: 'x'.repeat(300) },
    { sessionId: 'sess-1' },
    { locale: 'en' },
  );
  const line = lines(notification).find((value) => value.startsWith('x'));
  assert.equal(line.length, 200);
  assert.ok(line.endsWith('…'));
});

test('titles are folded onto a single line', () => {
  const notification = formatNotification(
    { status: 'completed' },
    { sessionId: SESSION_ID, title: '  Fix\n  login\t timeout  ' },
    { locale: 'en' },
  );
  assert.equal(lines(notification)[0], 'Fix login timeout');
});

/* ------------------------------------------------------------------ *
 * durations
 * ------------------------------------------------------------------ */

test('duration formatting', () => {
  const cases = [
    [1000, '1s'],
    [5000, '5s'],
    [59000, '59s'],
    [60000, '1m'],
    [90000, '1m30s'],
    [133000, '2m13s'],
    [3599000, '59m59s'],
    [3600000, '1h'],
    [3660000, '1h1m'],
  ];
  for (const [durationMs, expected] of cases) {
    const zh = formatNotification({ status: 'completed' }, { sessionId: 's1', durationMs }, { locale: 'zh' });
    assert.ok(lines(zh).includes(`耗时 ${expected}`), `${durationMs}ms -> 耗时 ${expected}`);
    const en = formatNotification({ status: 'completed' }, { sessionId: 's1', durationMs }, { locale: 'en' });
    assert.ok(lines(en).includes(`Elapsed ${expected}`), `${durationMs}ms -> Elapsed ${expected}`);
  }
});

test('elapsed line is omitted below one second or without a finite duration', () => {
  for (const durationMs of [999, 0, -5000, Number.NaN, Number.POSITIVE_INFINITY, '133000', null, undefined, {}]) {
    const notification = formatNotification({ status: 'completed' }, { sessionId: 's1', durationMs }, { locale: 'zh' });
    assert.ok(!notification.body.includes('耗时'), `durationMs=${String(durationMs)} must not add an elapsed line`);
    assert.equal(notification.text, `${notification.title}\n${notification.body}`);
  }
});

/* ------------------------------------------------------------------ *
 * degenerate input
 * ------------------------------------------------------------------ */

test('unknown statuses degrade gracefully instead of throwing', () => {
  const custom = formatNotification({ status: 'rate-limited' }, { sessionId: 'sess-1' }, { locale: 'zh' });
  assert.equal(custom.statusLabel, 'rate-limited');
  assert.equal(custom.title, '🔔 rate-limited');
  assert.equal(custom.level, 'info');
  assert.equal(custom.tag, 'dsh:rate-limited:sess-1');

  const missing = formatNotification({}, { sessionId: 'sess-1' }, { locale: 'zh' });
  assert.equal(missing.statusLabel, '通知');
  assert.equal(missing.title, '🔔 通知');
  assert.equal(missing.level, 'info');
  assert.equal(missing.tag, 'dsh:unknown:sess-1');

  const missingEn = formatNotification({ status: 42 }, {}, { locale: 'en' });
  assert.equal(missingEn.title, '🔔 Notification');
  assert.equal(missingEn.tag, 'dsh:unknown:-');
});

test('missing or hostile meta never throws and keeps the text invariant', () => {
  const hostileTitle = {
    toString() {
      throw new Error('boom');
    },
  };
  const inputs = [
    [undefined, undefined, undefined],
    [null, null, null],
    [{}, {}, {}],
    ['not-an-object', 'not-an-object', 'not-an-object'],
    [{ status: null }, { sessionId: 42, cwd: [], project: {}, durationMs: 'x' }, { locale: 7 }],
    [{ status: 'completed' }, { sessionId: SESSION_ID, title: 42 }, { locale: 'en' }],
    [{ status: 'completed' }, { sessionId: SESSION_ID, title: hostileTitle }, { locale: 'zh' }],
    [{ status: 'completed' }, { sessionId: SESSION_ID, title: '   ' }, { locale: 'en' }],
  ];

  for (const [signal, meta, options] of inputs) {
    const notification = formatNotification(signal, meta, options);
    assert.equal(typeof notification.title, 'string');
    assert.equal(typeof notification.body, 'string');
    assert.equal(typeof notification.statusLabel, 'string');
    assert.equal(typeof notification.tag, 'string');
    assert.ok(['info', 'warn', 'error'].includes(notification.level));
    assert.equal(notification.text, `${notification.title}\n${notification.body}`);
    assert.equal(notification.text.split('\n')[0], notification.title);
  }
});

test('a non-string title falls back to the short session id', () => {
  const notification = formatNotification(
    { status: 'completed' },
    { sessionId: SESSION_ID, title: { toString: () => 'nope' } },
    { locale: 'en' },
  );
  assert.equal(notification.body, SHORT_ID);
  assert.equal(notification.text, `✅ Task completed\n${SHORT_ID}`);
});
