/**
 * Bilingual (zh/en) notification formatting for the DSH notify-hook plugin.
 *
 * Zero dependencies, ESM only. This module imports nothing at all: it only uses
 * the `process` global (as a *default* argument value, so even that is optional).
 *
 * Design rule: **nothing here may throw**. Missing/hostile input degrades to a
 * shorter, still-useful notification instead of an exception, because this code
 * runs on the notification path of a background agent turn.
 *
 * @module lib/format
 */

/** @typedef {'zh'|'en'} Locale */
/** @typedef {'info'|'warn'|'error'} NotificationLevel */

/**
 * @typedef {object} Notification
 * @property {string} title       `<emoji> <statusLabel>`
 * @property {string} body        newline-joined detail lines (may be `''`)
 * @property {NotificationLevel} level
 * @property {string} tag         `dsh:<status>:<sessionId>` (desktop tag / dedupe group)
 * @property {string} statusLabel localized status text
 * @property {string} text        `${title}\n${body}` — the single chat-platform string
 */

/**
 * @typedef {object} NotificationMeta
 * @property {string} [sessionId]
 * @property {string} [title]
 * @property {string} [cwd]
 * @property {string} [project]
 * @property {number} [durationMs]
 * @property {boolean} [isSubagent]
 */

/** Supported locales, in preference order. @type {ReadonlyArray<Locale>} */
export const LOCALES = ['zh', 'en'];

/** Characters of a session id kept before the ellipsis (`session-c4460152…`). */
const SHORT_ID_CHARS = 16;

/** Ellipsis appended by every truncation in this plugin. */
const ELLIPSIS = '…';

/** Emoji per known status. Unknown statuses get `UNKNOWN_EMOJI`. */
const EMOJI = Object.freeze({
  completed: '✅',
  failed: '❌',
  'awaiting-input': '⏳',
  attention: '⚠️',
  cancelled: '⛔',
});

/** Notification level per known status. Unknown statuses get `'info'`. */
const LEVEL = Object.freeze({
  completed: 'info',
  failed: 'error',
  'awaiting-input': 'warn',
  attention: 'warn',
  cancelled: 'info',
});

const UNKNOWN_EMOJI = '🔔';

/**
 * Localized fragments. Values are functions where the text is parameterized.
 * @type {Record<Locale, {
 *   status: Record<string, string>,
 *   fallbackLabel: string,
 *   elapsed: (duration: string) => string,
 *   tool: (name: string) => string,
 *   cancel: (kind: string) => string,
 *   subagent: string,
 * }>}
 */
const STRINGS = Object.freeze({
  zh: Object.freeze({
    status: Object.freeze({
      completed: '任务完成',
      failed: '任务失败',
      'awaiting-input': '等待输入',
      attention: '需要关注',
      cancelled: '任务已取消',
    }),
    fallbackLabel: '通知',
    elapsed: (duration) => `耗时 ${duration}`,
    tool: (name) => `工具：${name}`,
    cancel: (kind) => `取消原因：${kind}`,
    subagent: '（子代理）',
  }),
  en: Object.freeze({
    status: Object.freeze({
      completed: 'Task completed',
      failed: 'Task failed',
      'awaiting-input': 'Waiting for input',
      attention: 'Needs attention',
      cancelled: 'Task cancelled',
    }),
    fallbackLabel: 'Notification',
    elapsed: (duration) => `Elapsed ${duration}`,
    tool: (name) => `Tool: ${name}`,
    cancel: (kind) => `Reason: ${kind}`,
    subagent: ' (subagent)',
  }),
});

/* ------------------------------------------------------------------ *
 * locale
 * ------------------------------------------------------------------ */

/**
 * Resolve a locale preference to a supported locale.
 *
 * - explicit `'zh'` / `'en'` (or any `zh-*` / `en-*` tag) always wins;
 * - otherwise `env.DSH_LOCALE` wins when it names a supported language;
 * - then the operating-system locale reported by `Intl`;
 * - then `env.LANG` / `env.LC_ALL` / `env.LC_MESSAGES` starting with `zh`;
 * - everything else — including an unknown locale — falls back to `'en'`.
 *
 * @param {'auto'|'zh'|'en'|string} [pref]
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [systemLocale]
 * @returns {Locale}
 */
export function resolveLocale(
  pref,
  env = process.env,
  systemLocale = env === process.env ? defaultSystemLocale() : '',
) {
  const explicit = explicitLocale(pref);
  if (explicit) return explicit;

  const source = isRecord(env) ? env : {};
  const dshLocale = explicitLocale(source.DSH_LOCALE);
  if (dshLocale) return dshLocale;
  const system = explicitLocale(systemLocale);
  if (system) return system;
  if (startsWithZh(source.LANG) || startsWithZh(source.LC_ALL) || startsWithZh(source.LC_MESSAGES)) {
    return 'zh';
  }
  return 'en';
}

/** Operating-system locale as seen by the DSH Node runtime. */
function defaultSystemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return '';
  }
}

/**
 * @param {unknown} value
 * @returns {Locale|''} `''` when the value expresses no concrete preference.
 */
function explicitLocale(value) {
  if (typeof value !== 'string') return '';
  const tag = value.trim().toLowerCase();
  if (!tag || tag === 'auto' || tag === 'system' || tag === 'default') return '';
  if (tag.startsWith('zh')) return 'zh';
  if (tag.startsWith('en')) return 'en';
  return '';
}

/**
 * @param {unknown} value
 * @returns {boolean} true when the value is a `zh*` locale tag.
 */
function startsWithZh(value) {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('zh');
}

/* ------------------------------------------------------------------ *
 * public formatting
 * ------------------------------------------------------------------ */

/**
 * Render a notification for one signal.
 *
 * Total by construction: a `null` signal, a non-object meta, a numeric title or
 * an unknown status all produce a (possibly shorter) notification, never a throw.
 *
 * @param {object} [signal] A `lib/classify.js` Signal (or anything signal-shaped).
 * @param {NotificationMeta|object} [meta]
 * @param {{ locale?: 'auto'|'zh'|'en'|string }} [options]
 * @returns {Notification}
 */
export function formatNotification(signal, meta = {}, options = {}) {
  const s = isRecord(signal) ? signal : {};
  const m = isRecord(meta) ? meta : {};
  const o = isRecord(options) ? options : {};

  const locale = resolveLocale(o.locale);
  const strings = STRINGS[locale] || STRINGS.en;

  const rawStatus = oneLine(s.status);
  const known = Object.prototype.hasOwnProperty.call(EMOJI, rawStatus);
  const statusLabel = known ? strings.status[rawStatus] : rawStatus || strings.fallbackLabel;
  const emoji = known ? EMOJI[rawStatus] : UNKNOWN_EMOJI;
  const level = known ? LEVEL[rawStatus] : 'info';
  const status = rawStatus || 'unknown';

  const title = `${emoji} ${statusLabel}`;
  const body = buildBody(s, m, strings, status);
  const tag = `dsh:${tagToken(status)}:${tagToken(str(m.sessionId)) || '-'}`;

  return { title, body, level, tag, statusLabel, text: `${title}\n${body}` };
}

/**
 * Detail lines, in spec order: task title, project/cwd, status detail,
 * elapsed, short session id. Lines that carry no information are omitted.
 *
 * @param {Record<string, any>} signal
 * @param {Record<string, any>} meta
 * @param {(typeof STRINGS)['en']} strings
 * @param {string} status
 * @returns {string}
 */
function buildBody(signal, meta, strings, status) {
  const lines = [];
  const sessionId = str(meta.sessionId);
  const short = shortId(sessionId);
  const marker = isSubagent(meta) ? strings.subagent : '';

  const taskTitle = oneLine(meta.title) || short;
  if (taskTitle) lines.push(marker ? `${taskTitle}${marker}` : taskTitle);
  else if (marker) lines.push(marker.trim());

  const place = basename(meta.project) || basename(meta.cwd);
  if (place) lines.push(place);

  const detail = detailLine(signal, strings, status);
  if (detail) lines.push(detail);

  if (Number.isFinite(meta.durationMs) && meta.durationMs >= 1000) {
    lines.push(strings.elapsed(formatDuration(meta.durationMs)));
  }

  // Avoid repeating the session id when it already acted as the task title.
  if (short && short !== taskTitle) lines.push(short);

  return lines.join('\n');
}

/**
 * The single "what happened" line: error `code: message`, question text,
 * tool name, or cancellation cause.
 *
 * @param {Record<string, any>} signal
 * @param {(typeof STRINGS)['en']} strings
 * @param {string} status
 * @returns {string}
 */
function detailLine(signal, strings, status) {
  const code = flat(signal.errorCode);
  const message = flat(signal.errorMessage);
  if (code && message) return `${code}: ${message}`;
  if (message) return message;
  if (code) return code;

  const question = flat(signal.question);
  if (question) return truncate(question, 200);

  const tool = flat(signal.toolName);
  if (tool) return strings.tool(tool);

  if (status === 'cancelled') {
    const kind = flat(signal.cancelKind);
    if (kind) return strings.cancel(kind);
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * small helpers (never throw)
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string} the value when it is a string, else `''`.
 */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Collapse newlines/tabs into single spaces and trim (keeps inner spacing).
 * @param {unknown} value
 * @returns {string}
 */
function flat(value) {
  return str(value).replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * Aggressive single-line fold for titles: also squeeze repeated spaces.
 * @param {unknown} value
 * @returns {string}
 */
function oneLine(value) {
  return flat(value).replace(/\s{2,}/g, ' ');
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function truncate(value, max) {
  const text = str(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`;
}

/**
 * Basename of a POSIX or Windows path.
 * @param {unknown} value
 * @returns {string}
 */
function basename(value) {
  const raw = str(value).trim();
  if (!raw) return '';
  const trimmed = raw.replace(/[\\/]+$/, '');
  if (!trimmed) return raw;
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return (cut >= 0 ? trimmed.slice(cut + 1) : trimmed).trim();
}

/**
 * First 16 characters of a session id, ellipsized (`session-c4460152…`).
 * @param {unknown} value
 * @returns {string}
 */
function shortId(value) {
  const id = str(value).trim();
  if (id.length <= SHORT_ID_CHARS) return id;
  return `${id.slice(0, SHORT_ID_CHARS)}${ELLIPSIS}`;
}

/**
 * `133000` -> `'2m13s'`; `1000` -> `'1s'`; `60000` -> `'1m'`; `3660000` -> `'1h1m'`.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Make a status/session id safe to embed in a `tag` string.
 * @param {string} value
 * @returns {string}
 */
function tagToken(value) {
  return value.trim().replace(/\s+/g, '-');
}

/**
 * @param {Record<string, any>} meta
 * @returns {boolean}
 */
function isSubagent(meta) {
  const flag = meta.isSubagent;
  if (flag === true) return true;
  return typeof flag === 'string' && flag.trim().toLowerCase() === 'true';
}
