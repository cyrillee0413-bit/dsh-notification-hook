/**
 * Tests for `lib/classify.js` — pure, no network, no real notifications.
 *
 * Run from the package directory: `node --test test/classify.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS,
  classifySessionEvent,
  classifyUserQuestion,
  decidedApprovalId,
  describeSignal,
} from '../lib/classify.js';

const TIME = 1_700_000_000_000;

/**
 * @param {string} kind
 * @param {Record<string, unknown>} [reasonExtra]
 * @returns {Record<string, unknown>} a well-formed `turn/end` envelope.
 */
function turnEnd(kind, reasonExtra = {}) {
  return {
    type: 'turn/end',
    seq: 7,
    time: TIME,
    data: { turn: 3, reason: { kind, ...reasonExtra } },
  };
}

/**
 * @param {Record<string, unknown>} data
 * @returns {Record<string, unknown>} an `approval/asked` envelope.
 */
function approvalAsked(data) {
  return { type: 'approval/asked', seq: 12, time: TIME, data };
}

// ---------------------------------------------------------------------------
// STATUS vocabulary
// ---------------------------------------------------------------------------

test('STATUS exposes exactly the five frozen statuses and is frozen', () => {
  assert.deepEqual(STATUS, {
    COMPLETED: 'completed',
    FAILED: 'failed',
    AWAITING_INPUT: 'awaiting-input',
    CANCELLED: 'cancelled',
    ATTENTION: 'attention',
  });
  assert.ok(Object.isFrozen(STATUS));
});

// ---------------------------------------------------------------------------
// Mapping table: turn/end rows
// ---------------------------------------------------------------------------

const TURN_END_ROWS = [
  ['completed', STATUS.COMPLETED],
  ['error', STATUS.FAILED],
  ['max-tokens', STATUS.ATTENTION],
  ['blocked', STATUS.AWAITING_INPUT],
  ['aborted', STATUS.CANCELLED],
  ['interrupted', STATUS.CANCELLED],
];

for (const [kind, status] of TURN_END_ROWS) {
  test(`turn/end kind=${kind} -> ${status} with dedupeKey turn/end:3`, () => {
    const signal = classifySessionEvent(turnEnd(kind));
    assert.ok(signal, `expected a signal for kind=${kind}`);
    assert.equal(signal.status, status);
    assert.equal(signal.source, 'session-event');
    assert.equal(signal.eventType, 'turn/end');
    assert.equal(signal.at, TIME);
    assert.equal(signal.seq, 7);
    assert.equal(signal.turn, 3);
    assert.equal(signal.dedupeKey, 'turn/end:3');
  });
}

test('turn/end kind=forked -> null (silent by design)', () => {
  assert.equal(classifySessionEvent(turnEnd('forked')), null);
});

test('turn/end with an unknown kind -> null (forward compatible, never invented)', () => {
  for (const kind of ['queued', 'paused', 'retrying', 'completed-v2', 'COMPLETED', '', ' ']) {
    assert.equal(classifySessionEvent(turnEnd(kind)), null, `kind=${JSON.stringify(kind)}`);
  }
});

test('turn/end kind lookup is prototype-safe', () => {
  for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(classifySessionEvent(turnEnd(kind)), null, `kind=${kind}`);
  }
});

test('turn/end kind must be a string', () => {
  for (const kind of [undefined, null, 42, true, {}, ['completed']]) {
    const event = { type: 'turn/end', time: TIME, data: { turn: 1, reason: { kind } } };
    assert.equal(classifySessionEvent(event), null, `kind=${String(kind)}`);
  }
});

test('turn/end missing reason -> null', () => {
  const events = [
    { type: 'turn/end', seq: 1, time: TIME },
    { type: 'turn/end', seq: 1, time: TIME, data: undefined },
    { type: 'turn/end', seq: 1, time: TIME, data: null },
    { type: 'turn/end', seq: 1, time: TIME, data: 'completed' },
    { type: 'turn/end', seq: 1, time: TIME, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: TIME, data: { turn: 1, reason: undefined } },
    { type: 'turn/end', seq: 1, time: TIME, data: { turn: 1, reason: null } },
    { type: 'turn/end', seq: 1, time: TIME, data: { turn: 1, reason: 'completed' } },
    { type: 'turn/end', seq: 1, time: TIME, data: { turn: 1, reason: 7 } },
  ];
  for (const event of events) {
    assert.equal(classifySessionEvent(event), null, JSON.stringify(event));
  }
});

test('turn/end error carries errorCode and errorMessage truncated to 300 chars', () => {
  const long = 'x'.repeat(500);
  const signal = classifySessionEvent(
    turnEnd('error', { error: { message: long, code: 'rate_limit', status: 429 } }),
  );
  assert.ok(signal);
  assert.equal(signal.status, STATUS.FAILED);
  assert.equal(signal.errorCode, 'rate_limit');
  assert.equal(signal.errorMessage.length, 300);
  assert.equal(signal.errorMessage, 'x'.repeat(300));
});

test('turn/end error tolerates a missing or wrongly typed LlmFailure', () => {
  const cases = [
    { kind: 'error' },
    { kind: 'error', error: null },
    { kind: 'error', error: 'boom' },
    { kind: 'error', error: { message: 42, code: null } },
    { kind: 'error', error: { message: '', code: '' } },
    { kind: 'error', error: { message: { text: 'nope' }, code: ['x'] } },
  ];
  for (const reason of cases) {
    const signal = classifySessionEvent({ type: 'turn/end', time: TIME, data: { turn: 2, reason } });
    assert.ok(signal, JSON.stringify(reason));
    assert.equal(signal.status, STATUS.FAILED);
    assert.equal(signal.errorCode, undefined);
    assert.equal(signal.errorMessage, undefined);
    assert.ok(!('errorCode' in signal));
    assert.ok(!('errorMessage' in signal));
  }
});

test('turn/end error message exactly at the 300 char boundary is not sliced', () => {
  const exact = 'y'.repeat(300);
  const signal = classifySessionEvent(turnEnd('error', { error: { message: exact, code: 'e' } }));
  assert.equal(signal.errorMessage, exact);
});

test('turn/end aborted surfaces the cancel cause as cancelKind', () => {
  assert.equal(classifySessionEvent(turnEnd('aborted', { reason: 'user' })).cancelKind, 'user');
  assert.equal(
    classifySessionEvent(turnEnd('aborted', { reason: { kind: 'timeout' } })).cancelKind,
    'timeout',
  );
  const bare = classifySessionEvent(turnEnd('aborted'));
  assert.equal(bare.status, STATUS.CANCELLED);
  assert.ok(!('cancelKind' in bare));
});

test('turn/end with a malformed turn still classifies with a stable fallback key', () => {
  const signal = classifySessionEvent({
    type: 'turn/end',
    seq: 41,
    time: TIME,
    data: { turn: 'three', reason: { kind: 'completed' } },
  });
  assert.ok(signal);
  assert.equal(signal.dedupeKey, 'turn/end:41');
  assert.ok(!('turn' in signal));
  assert.equal(signal.seq, 41);

  const noSeq = classifySessionEvent({
    type: 'turn/end',
    data: { turn: NaN, reason: { kind: 'completed' } },
  });
  assert.equal(noSeq.dedupeKey, 'turn/end:?');
  assert.ok(!('seq' in noSeq));
});

// ---------------------------------------------------------------------------
// Mapping table: approval rows
// ---------------------------------------------------------------------------

test('approval/asked happy path -> awaiting-input with tool, id and dedupeKey', () => {
  const signal = classifySessionEvent(
    approvalAsked({ id: 'ap-1', toolName: 'pwsh', callId: 'call-1', reason: 'shell' }),
  );
  assert.deepEqual(signal, {
    status: STATUS.AWAITING_INPUT,
    source: 'session-event',
    eventType: 'approval/asked',
    at: TIME,
    dedupeKey: 'approval:ap-1',
    seq: 12,
    toolName: 'pwsh',
    approvalId: 'ap-1',
  });
});

test('approval/asked tolerates missing data and falls back to callId for the key', () => {
  const bare = classifySessionEvent({ type: 'approval/asked', time: TIME });
  assert.deepEqual(bare, {
    status: STATUS.AWAITING_INPUT,
    source: 'session-event',
    eventType: 'approval/asked',
    at: TIME,
    dedupeKey: 'approval:?',
  });

  const byCall = classifySessionEvent(approvalAsked({ callId: 'call-9' }));
  assert.equal(byCall.dedupeKey, 'approval:call-9');
  assert.ok(!('approvalId' in byCall));
  assert.ok(!('toolName' in byCall));

  const wrongTypes = classifySessionEvent(
    approvalAsked({ id: 7, toolName: {}, callId: [] }),
  );
  assert.equal(wrongTypes.dedupeKey, 'approval:?');
  assert.ok(!('approvalId' in wrongTypes));
});

test('approval/decided -> null', () => {
  assert.equal(
    classifySessionEvent({ type: 'approval/decided', seq: 13, time: TIME, data: { id: 'ap-1', outcome: 'allow' } }),
    null,
  );
  assert.equal(classifySessionEvent({ type: 'approval/decided' }), null);
});

test('decidedApprovalId returns the approval id for approval/decided', () => {
  assert.equal(
    decidedApprovalId({ type: 'approval/decided', seq: 13, time: TIME, data: { id: 'ap-1', outcome: 'deny' } }),
    'ap-1',
  );
});

test('decidedApprovalId -> null for anything else or a malformed id', () => {
  const cases = [
    undefined,
    null,
    42,
    'approval/decided',
    {},
    { type: 'approval/asked', data: { id: 'ap-1' } },
    { type: 'approval/decided' },
    { type: 'approval/decided', data: null },
    { type: 'approval/decided', data: 'ap-1' },
    { type: 'approval/decided', data: {} },
    { type: 'approval/decided', data: { id: 7 } },
    { type: 'approval/decided', data: { id: '' } },
    { type: 'approval/decided', data: { id: null } },
  ];
  for (const event of cases) {
    assert.equal(decidedApprovalId(event), null, JSON.stringify(event) ?? String(event));
  }
});

// ---------------------------------------------------------------------------
// Mapping table: anything else / malformed events
// ---------------------------------------------------------------------------

test('non-notify-worthy event types -> null', () => {
  const types = ['turn/start', 'session/title', 'session/end', 'message/part', 'unknown/future', ''];
  for (const type of types) {
    assert.equal(classifySessionEvent({ type, seq: 1, time: TIME, data: {} }), null, type);
  }
});

test('malformed inputs return null without throwing', () => {
  const inputs = [
    undefined,
    null,
    42,
    0,
    NaN,
    '',
    'turn/end',
    true,
    false,
    [],
    [1, 2],
    () => {},
    Symbol('turn/end'),
    10n,
    {},
    { type: 'turn/end' },
    { type: 42, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: null, data: null },
  ];
  for (const input of inputs) {
    assert.equal(classifySessionEvent(input), null, String(input?.toString?.() ?? input));
  }
});

test('hostile getters never make classifySessionEvent or decidedApprovalId throw', () => {
  const hostileData = {
    type: 'turn/end',
    time: TIME,
    get data() {
      throw new Error('boom');
    },
  };
  assert.equal(classifySessionEvent(hostileData), null);
  assert.equal(decidedApprovalId(hostileData), null);

  const hostileType = {
    get type() {
      throw new Error('boom');
    },
  };
  assert.equal(classifySessionEvent(hostileType), null);
  assert.equal(decidedApprovalId(hostileType), null);
});

// ---------------------------------------------------------------------------
// `at` resolution
// ---------------------------------------------------------------------------

test('at preserves a finite event.time', () => {
  assert.equal(classifySessionEvent(turnEnd('completed')).at, TIME);
  assert.equal(classifySessionEvent({ ...turnEnd('completed'), time: 0 }).at, 0);
});

test('at falls back to Date.now() when event.time is not a finite number', () => {
  const badTimes = [undefined, null, NaN, Infinity, -Infinity, '1700000000000', {}, [], true];
  for (const time of badTimes) {
    const before = Date.now();
    const signal = classifySessionEvent({ ...turnEnd('completed'), time });
    const after = Date.now();
    assert.ok(signal, `time=${String(time)}`);
    assert.equal(typeof signal.at, 'number');
    assert.ok(Number.isFinite(signal.at));
    assert.ok(signal.at >= before && signal.at <= after, `time=${String(time)} -> at=${signal.at}`);
    assert.equal(signal.dedupeKey, 'turn/end:3');
  }
});

test('approval/asked also falls back when event.time is missing', () => {
  const before = Date.now();
  const signal = classifySessionEvent({ type: 'approval/asked', data: { id: 'ap-2' } });
  const after = Date.now();
  assert.ok(signal.at >= before && signal.at <= after);
});

// ---------------------------------------------------------------------------
// dedupeKey stability
// ---------------------------------------------------------------------------

test('dedupeKey is stable for identical input and differs across turns', () => {
  assert.equal(classifySessionEvent(turnEnd('completed')).dedupeKey, 'turn/end:3');
  assert.equal(
    classifySessionEvent(turnEnd('completed')).dedupeKey,
    classifySessionEvent(turnEnd('completed')).dedupeKey,
  );

  const turn4 = { type: 'turn/end', seq: 9, time: TIME, data: { turn: 4, reason: { kind: 'completed' } } };
  assert.equal(classifySessionEvent(turn4).dedupeKey, 'turn/end:4');
  assert.notEqual(classifySessionEvent(turn4).dedupeKey, classifySessionEvent(turnEnd('completed')).dedupeKey);
});

test('dedupeKey ignores time/seq/status and is namespaced per event type', () => {
  const a = { type: 'turn/end', seq: 1, time: 1, data: { turn: 5, reason: { kind: 'error' } } };
  const b = { type: 'turn/end', seq: 99, time: 2, data: { turn: 5, reason: { kind: 'completed' } } };
  assert.equal(classifySessionEvent(a).dedupeKey, classifySessionEvent(b).dedupeKey);
  assert.notEqual(
    classifySessionEvent(a).dedupeKey,
    classifySessionEvent(approvalAsked({ id: 'turn/end:5' })).dedupeKey,
  );
});

// ---------------------------------------------------------------------------
// classifyUserQuestion
// ---------------------------------------------------------------------------

test('classifyUserQuestion happy path always reports the frozen identity fields', () => {
  const request = {
    questions: [
      { id: 'a', question: 'Pick one', header: 'Choice', options: [{ label: 'x' }] },
      { id: 'b', question: 'Pick two' },
    ],
    agent: {},
    signal: {},
    wait: { callId: 'call-9', timed: false },
  };
  const before = Date.now();
  const signal = classifyUserQuestion(request, { sessionId: 'session-1' });
  const after = Date.now();

  assert.deepEqual(Object.keys(signal).sort(), [
    'at',
    'dedupeKey',
    'eventType',
    'question',
    'questionCount',
    'source',
    'status',
    'toolName',
  ]);
  assert.equal(signal.status, 'awaiting-input');
  assert.equal(signal.source, 'user-question');
  assert.equal(signal.eventType, 'user-questions/request');
  assert.equal(signal.toolName, 'ask_user_question');
  assert.equal(signal.question, 'Pick one');
  assert.equal(signal.questionCount, 2);
  assert.equal(signal.dedupeKey, 'question:session-1:call-9');
  assert.ok(Number.isFinite(signal.at) && signal.at >= before && signal.at <= after);
});

test('classifyUserQuestion dedupeKey falls back to comma-joined question ids', () => {
  const request = { questions: [{ id: 'a', question: 'A?' }, { id: 'b', question: 'B?' }] };
  assert.equal(classifyUserQuestion(request, { sessionId: 's1' }).dedupeKey, 'question:s1:a,b');

  const single = { questions: [{ id: 'only', question: 'A?' }] };
  assert.equal(classifyUserQuestion(single, { sessionId: 's1' }).dedupeKey, 'question:s1:only');
});

test('classifyUserQuestion dedupeKey without sessionId is question:-', () => {
  const request = { questions: [{ id: 'a', question: 'A?' }], wait: { callId: 'call-1' } };
  assert.equal(classifyUserQuestion(request).dedupeKey, 'question:-');
  assert.equal(classifyUserQuestion(request, {}).dedupeKey, 'question:-');
  assert.equal(classifyUserQuestion(request, { sessionId: '' }).dedupeKey, 'question:-');
  assert.equal(classifyUserQuestion(request, { sessionId: 42 }).dedupeKey, 'question:-');
  assert.equal(classifyUserQuestion(request, null).dedupeKey, 'question:-');
});

test('classifyUserQuestion tolerates missing or empty questions', () => {
  const requests = [
    undefined,
    null,
    42,
    'questions',
    {},
    { questions: null },
    { questions: 'nope' },
    { questions: [] },
    { questions: [null] },
    { questions: [{}] },
    { questions: [{ id: 'a' }] },
    { questions: [{ id: 'a', question: '' }] },
    { questions: [{ id: 'a', question: 42 }] },
  ];
  for (const request of requests) {
    const signal = classifyUserQuestion(request, { sessionId: 's1' });
    assert.equal(signal.status, 'awaiting-input', String(request));
    assert.equal(signal.source, 'user-question');
    assert.equal(signal.eventType, 'user-questions/request');
    assert.equal(signal.toolName, 'ask_user_question');
    assert.equal(typeof signal.dedupeKey, 'string');
    assert.ok(signal.dedupeKey.startsWith('question:'));
    assert.ok(!('question' in signal));
  }
  assert.equal(classifyUserQuestion({ questions: [] }, { sessionId: 's1' }).questionCount, 0);
  assert.equal(classifyUserQuestion({ questions: [null] }, { sessionId: 's1' }).questionCount, 1);
  assert.equal(classifyUserQuestion().questionCount, 0);
});

test('classifyUserQuestion truncates the question to 200 chars', () => {
  const long = 'q'.repeat(250);
  const signal = classifyUserQuestion({ questions: [{ id: 'a', question: long }] }, { sessionId: 's1' });
  assert.equal(signal.question.length, 200);
  assert.equal(signal.question, 'q'.repeat(200));

  const exact = 'z'.repeat(200);
  assert.equal(
    classifyUserQuestion({ questions: [{ id: 'a', question: exact }] }, { sessionId: 's1' }).question,
    exact,
  );
  const over = 'z'.repeat(201);
  assert.equal(
    classifyUserQuestion({ questions: [{ id: 'a', question: over }] }, { sessionId: 's1' }).question.length,
    200,
  );
});

test('classifyUserQuestion ignores a non-string wait.callId', () => {
  const request = { questions: [{ id: 'a', question: 'A?' }], wait: { callId: 42 } };
  assert.equal(classifyUserQuestion(request, { sessionId: 's1' }).dedupeKey, 'question:s1:a');
  assert.equal(
    classifyUserQuestion({ ...request, wait: 'call-1' }, { sessionId: 's1' }).dedupeKey,
    'question:s1:a',
  );
});

test('classifyUserQuestion dedupeKey is stable for the same request', () => {
  const request = { questions: [{ id: 'a', question: 'A?' }], wait: { callId: 'call-1' } };
  assert.equal(
    classifyUserQuestion(request, { sessionId: 's1' }).dedupeKey,
    classifyUserQuestion(request, { sessionId: 's1' }).dedupeKey,
  );
  assert.notEqual(
    classifyUserQuestion(request, { sessionId: 's1' }).dedupeKey,
    classifyUserQuestion(request, { sessionId: 's2' }).dedupeKey,
  );
});

test('classifyUserQuestion never throws, not even on hostile getters', () => {
  const hostile = {
    get questions() {
      throw new Error('boom');
    },
  };
  const signal = classifyUserQuestion(hostile, { sessionId: 's1' });
  assert.equal(signal.status, 'awaiting-input');
  assert.equal(signal.eventType, 'user-questions/request');
  assert.equal(signal.dedupeKey, 'question:-');
});

// ---------------------------------------------------------------------------
// describeSignal
// ---------------------------------------------------------------------------

test('describeSignal renders eventType:status one-liners', () => {
  assert.equal(describeSignal(classifySessionEvent(turnEnd('completed'))), 'turn/end:completed');
  assert.equal(describeSignal(classifySessionEvent(turnEnd('error'))), 'turn/end:failed');
  assert.equal(describeSignal(classifySessionEvent(turnEnd('max-tokens'))), 'turn/end:attention');
  assert.equal(describeSignal(classifySessionEvent(turnEnd('blocked'))), 'turn/end:awaiting-input');
  assert.equal(describeSignal(classifySessionEvent(turnEnd('aborted'))), 'turn/end:cancelled');
  assert.equal(describeSignal(classifySessionEvent(turnEnd('interrupted'))), 'turn/end:cancelled');
  assert.equal(
    describeSignal(classifySessionEvent(approvalAsked({ id: 'ap-1', toolName: 'pwsh' }))),
    'approval/asked:awaiting-input',
  );
  assert.equal(
    describeSignal(classifyUserQuestion({ questions: [{ id: 'a', question: 'A?' }] }, { sessionId: 's' })),
    'user-questions/request:awaiting-input',
  );
});

test('describeSignal tolerates malformed signals', () => {
  for (const value of [undefined, null, 42, 'turn/end', {}, [], true]) {
    assert.equal(describeSignal(value), 'unknown', String(value));
  }
  assert.equal(describeSignal({ eventType: 'turn/end' }), 'turn/end:?');
  assert.equal(describeSignal({ status: 'completed' }), '?:completed');
  assert.equal(describeSignal({ eventType: '', status: '' }), 'unknown');
  assert.equal(
    describeSignal({
      get eventType() {
        throw new Error('boom');
      },
    }),
    'unknown',
  );
});

// ---------------------------------------------------------------------------
// Whole-surface never-throw sweep
// ---------------------------------------------------------------------------

test('no export throws for any primitive or junk input', () => {
  const junk = [
    undefined,
    null,
    0,
    42,
    -1,
    NaN,
    Infinity,
    '',
    'turn/end',
    true,
    false,
    [],
    [1, 2],
    {},
    () => {},
    Symbol('x'),
    10n,
    new Date(),
    /re/,
    new Map(),
  ];
  for (const value of junk) {
    assert.doesNotThrow(() => {
      classifySessionEvent(value);
      classifyUserQuestion(value);
      decidedApprovalId(value);
      describeSignal(value);
    }, `input ${String(value)}`);
  }

  const nested = [
    { type: 'turn/end', seq: {}, time: [], data: { turn: {}, reason: { kind: 'error', error: { message: {}, code: [] } } } },
    { type: 'turn/end', seq: '1', time: '1', data: [] },
    { type: 'approval/asked', seq: NaN, time: {}, data: [] },
    { type: 'approval/decided', seq: null, time: null, data: [] },
    { type: 'user-questions/request', data: { questions: [{ id: {}, question: [] }], wait: [] } },
  ];
  for (const value of nested) {
    assert.doesNotThrow(() => {
      classifySessionEvent(value);
      classifyUserQuestion(value.data, { sessionId: value.type });
      decidedApprovalId(value);
      describeSignal(classifySessionEvent(value));
    }, JSON.stringify(value));
  }
});
