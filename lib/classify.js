/**
 * Notification signal classification for `dsh-notification-hook`.
 *
 * This module is intentionally dependency-free: it imports nothing at all (not
 * even `node:*`), has no side effects and holds no state, so it can run in any
 * context and be reasoned about in isolation.
 *
 * Every export is total: malformed input (`undefined`, `null`, primitives, a
 * missing `data`/`reason`, wrongly typed fields, or a `reason.kind` this module
 * does not know about) never throws. Unknown event shapes classify to `null`
 * instead of a defensively invented status.
 *
 * @module dsh-notification-hook/lib/classify
 */

/** @typedef {'completed'|'failed'|'awaiting-input'|'cancelled'|'attention'} SignalStatus */

/**
 * @typedef {object} Signal
 * @property {SignalStatus} status      What the user should be told about.
 * @property {'session-event'|'user-question'} source Where the signal came from.
 * @property {string} eventType         'turn/end' | 'approval/asked' | 'user-questions/request'.
 * @property {number} at                Epoch ms; `event.time` when finite, else `Date.now()`.
 * @property {number} [seq]             Session event sequence, when finite.
 * @property {number} [turn]            Turn number for `turn/end`, when finite.
 * @property {string} dedupeKey         Stable identity of this signal inside one session.
 * @property {string} [toolName]        Tool awaiting approval (`approval/asked`).
 * @property {string} [approvalId]      Approval id (`approval/asked`).
 * @property {string} [errorCode]       `LlmFailure.code` (`turn/end` + `error`).
 * @property {string} [errorMessage]    `LlmFailure.message`, truncated to 300 chars.
 * @property {string} [cancelKind]      Cancel cause (`turn/end` + `aborted`).
 * @property {string} [question]        First question text, truncated to 200 chars.
 * @property {number} [questionCount]   Number of questions in the request.
 */

/** Status vocabulary shared with `lib/format.js` and `lib/config.js`. */
export const STATUS = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  AWAITING_INPUT: 'awaiting-input',
  CANCELLED: 'cancelled',
  ATTENTION: 'attention',
});

/** Maximum stored length of {@link Signal.errorMessage}. */
const ERROR_MESSAGE_MAX = 300;

/** Maximum stored length of {@link Signal.question}. */
const QUESTION_MAX = 200;

/** Placeholder for an id-shaped field that is missing or not a usable string. */
const UNKNOWN = '?';

/**
 * `TurnEndReasonMap` entry kind -> status. Every kind outside this map (including
 * `forked`, which is deliberately silent, and any kind a future DSH version or
 * another plugin adds) classifies to `null`. A `Map` keeps the lookup safe against
 * prototype keys such as `'constructor'`.
 *
 * @type {ReadonlyMap<string, SignalStatus>}
 */
const TURN_END_STATUS = new Map([
  ['completed', STATUS.COMPLETED],
  ['error', STATUS.FAILED],
  ['max-tokens', STATUS.ATTENTION],
  ['blocked', STATUS.AWAITING_INPUT],
  ['aborted', STATUS.CANCELLED],
  ['interrupted', STATUS.CANCELLED],
]);

/**
 * @param {unknown} value
 * @returns {boolean} true for a non-null object (arrays included).
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * @param {unknown} value
 * @returns {string|undefined} the value when it is a non-empty string.
 */
function asString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {number|undefined} the value when it is a finite number.
 */
function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string|undefined} the value when it is a non-empty string, sliced to `max` chars.
 */
function limit(value, max) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * @param {Record<string, unknown>} event
 * @returns {number} `event.time` when finite, else the current wall clock.
 */
function resolveAt(event) {
  return asNumber(event.time) ?? Date.now();
}

/**
 * `aborted` carries a `TurnEndCancelCause`; accept either the cause string itself
 * or an object carrying a string `kind`.
 *
 * @param {unknown} cause
 * @returns {string|undefined}
 */
function cancelKindOf(cause) {
  if (typeof cause === 'string') return cause.length > 0 ? cause : undefined;
  if (isRecord(cause)) return asString(cause.kind);
  return undefined;
}

/**
 * @param {Signal} signal
 * @param {Record<string, unknown>} event
 * @returns {void}
 */
function addSeq(signal, event) {
  const seq = asNumber(event.seq);
  if (seq !== undefined) signal.seq = seq;
}

/**
 * Map one committed SessionEvent to a Signal, or null when it is not notify-worthy.
 *
 * Never throws: non-object events, unknown event types and malformed data all
 * return `null`.
 *
 * @param {unknown} event SessionEvent envelope `{ type, seq, time, data, ignorable? }`.
 * @returns {Signal|null}
 */
export function classifySessionEvent(event) {
  try {
    if (!isRecord(event)) return null;
    if (event.type === 'turn/end') return classifyTurnEnd(event);
    if (event.type === 'approval/asked') return classifyApprovalAsked(event);
    // `approval/decided`, `turn/start`, `session/title`, ... and every future
    // event type this module does not know about are not notify-worthy on their own.
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} event
 * @returns {Signal|null}
 */
function classifyTurnEnd(event) {
  const data = isRecord(event.data) ? event.data : {};
  const reason = isRecord(data.reason) ? data.reason : {};
  const kind = asString(reason.kind);
  const status = kind === undefined ? undefined : TURN_END_STATUS.get(kind);
  // `forked`, a missing `kind`, or a kind added by a future DSH version: stay silent.
  if (status === undefined) return null;

  const turn = asNumber(data.turn);
  // `<turn>` is the documented key; `seq`/`?` only matter for malformed events
  // that omit a usable turn number, so the key stays stable and per-event unique.
  const turnKey = turn ?? asNumber(event.seq) ?? UNKNOWN;

  /** @type {Signal} */
  const signal = {
    status,
    source: 'session-event',
    eventType: 'turn/end',
    at: resolveAt(event),
    dedupeKey: `turn/end:${turnKey}`,
  };
  addSeq(signal, event);
  if (turn !== undefined) signal.turn = turn;

  if (kind === 'error') {
    const error = isRecord(reason.error) ? reason.error : {};
    const code = asString(error.code);
    const message = limit(error.message, ERROR_MESSAGE_MAX);
    if (code !== undefined) signal.errorCode = code;
    if (message !== undefined) signal.errorMessage = message;
  }

  if (kind === 'aborted') {
    const cancelKind = cancelKindOf(reason.reason);
    if (cancelKind !== undefined) signal.cancelKind = cancelKind;
  }

  return signal;
}

/**
 * @param {Record<string, unknown>} event
 * @returns {Signal}
 */
function classifyApprovalAsked(event) {
  const data = isRecord(event.data) ? event.data : {};
  const approvalId = asString(data.id);
  const callId = asString(data.callId);
  const toolName = asString(data.toolName);

  /** @type {Signal} */
  const signal = {
    status: STATUS.AWAITING_INPUT,
    source: 'session-event',
    eventType: 'approval/asked',
    at: resolveAt(event),
    dedupeKey: `approval:${approvalId ?? callId ?? UNKNOWN}`,
  };
  addSeq(signal, event);
  if (toolName !== undefined) signal.toolName = toolName;
  if (approvalId !== undefined) signal.approvalId = approvalId;
  return signal;
}

/**
 * Map a `user-questions/request` payload to a Signal (always awaiting-input).
 *
 * Total by design: a missing/empty/oddly typed `questions` array still yields a
 * complete signal, and a missing `wait.callId` falls back to the comma-joined
 * question ids.
 *
 * @param {unknown} request `AskUserQuestionRequestEvent`.
 * @param {{ sessionId?: string }} [meta]
 * @returns {Signal}
 */
export function classifyUserQuestion(request, meta = {}) {
  try {
    const payload = isRecord(request) ? request : {};
    const info = isRecord(meta) ? meta : {};
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const first = isRecord(questions[0]) ? questions[0] : {};
    const wait = isRecord(payload.wait) ? payload.wait : {};
    const sessionId = asString(info.sessionId);
    const callId = asString(wait.callId);

    /** @type {string} */
    let dedupeKey;
    if (sessionId === undefined) {
      dedupeKey = 'question:-';
    } else if (callId !== undefined) {
      dedupeKey = `question:${sessionId}:${callId}`;
    } else {
      dedupeKey = `question:${sessionId}:${questionIds(questions)}`;
    }

    /** @type {Signal} */
    const signal = {
      status: STATUS.AWAITING_INPUT,
      source: 'user-question',
      eventType: 'user-questions/request',
      at: Date.now(),
      dedupeKey,
      toolName: 'ask_user_question',
      questionCount: questions.length,
    };
    const question = limit(first.question, QUESTION_MAX);
    if (question !== undefined) signal.question = question;
    return signal;
  } catch {
    // Nothing here is expected to throw; if a hostile getter does, still report a
    // usable awaiting-input signal rather than dropping the user's question.
    return {
      status: STATUS.AWAITING_INPUT,
      source: 'user-question',
      eventType: 'user-questions/request',
      at: Date.now(),
      dedupeKey: 'question:-',
      toolName: 'ask_user_question',
      questionCount: 0,
    };
  }
}

/**
 * @param {unknown[]} questions
 * @returns {string} comma-joined question ids, skipping entries without a string id.
 */
function questionIds(questions) {
  /** @type {string[]} */
  const ids = [];
  for (const question of questions) {
    const id = isRecord(question) ? asString(question.id) : undefined;
    if (id !== undefined) ids.push(id);
  }
  return ids.join(',');
}

/**
 * `approval/decided` -> its id, so a pending awaiting-input debounce can be cancelled.
 *
 * @param {unknown} event SessionEvent envelope.
 * @returns {string|null}
 */
export function decidedApprovalId(event) {
  try {
    if (!isRecord(event) || event.type !== 'approval/decided') return null;
    const data = isRecord(event.data) ? event.data : {};
    return asString(data.id) ?? null;
  } catch {
    return null;
  }
}

/**
 * Machine-readable one-liner used in logs, e.g. `turn/end:completed`.
 *
 * @param {unknown} signal
 * @returns {string}
 */
export function describeSignal(signal) {
  try {
    if (!isRecord(signal)) return 'unknown';
    const eventType = asString(signal.eventType);
    const status = asString(signal.status);
    if (eventType !== undefined && status !== undefined) return `${eventType}:${status}`;
    if (status !== undefined) return `?:${status}`;
    if (eventType !== undefined) return `${eventType}:?`;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
