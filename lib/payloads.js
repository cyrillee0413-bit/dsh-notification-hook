/**
 * Provider payload builders for the DSH notify-hook plugin.
 *
 * Zero dependencies, ESM only. Imports a single `node:*` builtin (`node:buffer`)
 * and nothing else.
 *
 * Every builder returns the exact wire shape the provider documents, so the
 * field names here are a real contract and must not be "improved":
 *
 * - feishu   (custom bot webhook) `msg_type` + `content.text`
 * - wecom    (group robot)        `msgtype`  + `text.content`
 * - telegram (Bot API)            `chat_id`  + `text` + `disable_web_page_preview`
 * - discord  (webhook)            `content`  + `username`
 * - slack    (incoming webhook)   `text`
 * - generic                       structured JSON for self-hosted receivers
 *
 * @module lib/payloads
 */

import { Buffer } from 'node:buffer';

/**
 * Accepted `target.type` values. `auto` (and a missing type) resolves through
 * {@link detectTargetType}.
 * @type {ReadonlyArray<string>}
 */
export const TARGET_TYPES = Object.freeze([
  'auto',
  'generic',
  'feishu',
  'wecom',
  'telegram',
  'discord',
  'slack',
]);

/** Hard cap on the serialized request body: 64 KiB. */
const MAX_BODY_BYTES = 64 * 1024;

/** Appended to every text field this module truncates. */
const ELLIPSIS = '…';

/** Discord hard-limits webhook `content` to 2000 characters. */
const DISCORD_CONTENT_CHARS = 1900;

/** Default content type of every body this module produces. */
const JSON_CONTENT_TYPE = 'application/json';

/**
 * Configuration/usage error for a single notification target.
 * Thrown for an unknown explicit `type`, a missing `target.url`, or a Telegram
 * target without `chatId`. A *recoverable* transport problem (unparseable URL,
 * DNS failure, timeout) is never a `PayloadError` — that is `lib/http.js`'s job.
 */
export class PayloadError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PayloadError';
  }
}

/**
 * @typedef {object} Target
 * @property {string} [name]
 * @property {'auto'|'generic'|'feishu'|'wecom'|'telegram'|'discord'|'slack'|string} [type]
 * @property {string} url
 * @property {string|number} [chatId]   Telegram only.
 * @property {Record<string, string>} [headers] Extra headers; they win over defaults.
 */

/**
 * @typedef {object} BuiltRequest
 * @property {string} url
 * @property {'POST'} method
 * @property {Record<string,string>} headers
 * @property {string} body
 */

/* ------------------------------------------------------------------ *
 * detection / redaction
 * ------------------------------------------------------------------ */

/**
 * Sniff the provider type from a webhook URL (host first, then path).
 * Anything unparseable or unrecognized is `generic`.
 *
 * @param {unknown} url
 * @returns {'generic'|'feishu'|'wecom'|'telegram'|'discord'|'slack'}
 */
export function detectTargetType(url) {
  const parsed = parseUrl(url);
  if (!parsed) return 'generic';

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const onHost = (suffix) => host === suffix || host.endsWith(`.${suffix}`);

  if (onHost('telegram.org')) return 'telegram';
  if (onHost('weixin.qq.com') || path.includes('/cgi-bin/webhook/')) return 'wecom';
  if (host.includes('feishu') || path.includes('/open-apis/bot/')) return 'feishu';
  if (onHost('discord.com') || onHost('discordapp.com') || path.includes('/api/webhooks/')) {
    return 'discord';
  }
  if (onHost('hooks.slack.com') || (onHost('slack.com') && path.includes('/services/'))) {
    return 'slack';
  }
  return 'generic';
}

/**
 * Log-safe rendering of a webhook URL.
 *
 * Keeps the origin and replaces any non-root path with `…`; query and hash are
 * dropped entirely. Any non-root path is collapsed to a
 * marker: custom webhook paths are just as capable of carrying credentials as
 * the well-known provider formats, so no path segment is safe to log.
 *
 * @param {unknown} url
 * @returns {string}
 */
export function redactUrl(url) {
  if (typeof url !== 'string') return '';
  const raw = url.trim();
  if (!raw) return '';

  const parsed = parseUrl(raw);
  if (!parsed) return redactUnparseable(raw);

  const hasPath = parsed.pathname.split('/').some((segment) => segment.length > 0);
  return hasPath ? `${parsed.origin}/${ELLIPSIS}` : parsed.origin;
}

/**
 * A malformed authority cannot be separated reliably from embedded credentials.
 * Keep no part of it.
 * @param {string} raw
 * @returns {string}
 */
function redactUnparseable(raw) {
  void raw;
  return '<invalid-url>';
}

/* ------------------------------------------------------------------ *
 * request building
 * ------------------------------------------------------------------ */

/**
 * Build the HTTP request for one target.
 *
 * @param {Target} target
 * @param {{ text?: string, title?: string, body?: string, statusLabel?: string, level?: string }} notification
 * @param {object} [meta] Delivery meta; `meta.signal` (or `meta` itself) supplies
 *   the signal fields used by the `generic` body.
 * @returns {BuiltRequest}
 * @throws {PayloadError} unknown explicit `type`, missing `url`, Telegram without `chatId`.
 */
export function buildRequest(target, notification = {}, meta = {}) {
  const t = isRecord(target) ? target : {};
  const url = typeof t.url === 'string' ? t.url.trim() : '';
  if (!url) throw new PayloadError('target.url must be a non-empty string');

  const type = resolveType(t.type, url);
  const n = isRecord(notification) ? notification : {};
  const m = isRecord(meta) ? meta : {};
  const text = resolveText(n);

  /** @type {Record<string, unknown>} */
  let body;
  switch (type) {
    case 'feishu':
      body = { msg_type: 'text', content: { text } };
      break;
    case 'wecom':
      body = { msgtype: 'text', text: { content: text } };
      break;
    case 'telegram': {
      const chatId = normalizeChatId(t.chatId);
      if (chatId === null) {
        throw new PayloadError('telegram target requires a non-empty chatId');
      }
      body = { chat_id: chatId, text, disable_web_page_preview: true };
      break;
    }
    case 'discord':
      body = { content: sliceChars(text, DISCORD_CONTENT_CHARS), username: 'DSH' };
      break;
    case 'slack':
      body = { text };
      break;
    default:
      body = buildGenericBody(n, m);
      break;
  }

  return {
    url,
    method: 'POST',
    headers: buildHeaders(t.headers),
    body: fitBody(body),
  };
}

/**
 * Resolve `target.type` to a concrete provider.
 * @param {unknown} rawType
 * @param {string} url
 * @returns {'generic'|'feishu'|'wecom'|'telegram'|'discord'|'slack'}
 * @throws {PayloadError} when an explicit type is not in {@link TARGET_TYPES}.
 */
function resolveType(rawType, url) {
  const type = typeof rawType === 'string' ? rawType.trim().toLowerCase() : '';
  if (!type || type === 'auto') return detectTargetType(url);
  if (TARGET_TYPES.includes(type)) {
    return /** @type {'generic'|'feishu'|'wecom'|'telegram'|'discord'|'slack'} */ (type);
  }
  throw new PayloadError(`unknown target type: ${String(rawType)}`);
}

/**
 * The single string chat platforms send: `notification.text`, or the
 * `${title}\n${body}` reconstruction when only the parts are available.
 * @param {Record<string, any>} notification
 * @returns {string}
 */
function resolveText(notification) {
  const text = str(notification.text);
  if (text) return text;
  if (typeof notification.title === 'string' || typeof notification.body === 'string') {
    return `${str(notification.title)}\n${str(notification.body)}`;
  }
  return '';
}

/**
 * Structured body for generic receivers.
 *
 * `event` and the signal-derived fields come from `meta.signal` when present;
 * otherwise `meta` itself is read, so a caller may inline `status`, `toolName`,
 * … into the delivery meta.
 * @param {Record<string, any>} notification
 * @param {Record<string, any>} meta
 * @returns {Record<string, unknown>}
 */
function buildGenericBody(notification, meta) {
  const signal = isRecord(meta.signal) ? meta.signal : meta;
  const status =
    firstString(signal.status, meta.status, notification.status, statusFromTag(notification.tag)) ||
    'unknown';
  return {
    source: 'dsh-notification-hook',
    event: status,
    statusLabel: str(notification.statusLabel),
    title: str(notification.title),
    body: str(notification.body),
    text: resolveText(notification),
    sessionId: str(meta.sessionId),
    sessionTitle: str(meta.sessionTitle) || str(meta.title),
    cwd: str(meta.cwd),
    durationMs: Number.isFinite(meta.durationMs) ? meta.durationMs : null,
    toolName: str(signal.toolName),
    errorCode: str(signal.errorCode),
    errorMessage: str(signal.errorMessage),
    at: toIsoString(signal.at === undefined ? meta.at : signal.at),
  };
}

/**
 * `dsh:<status>:<sessionId>` -> `<status>`. Last-resort source for `event` when
 * the caller passes no signal at all, since the formatter always encodes the
 * status in the tag.
 * @param {unknown} tag
 * @returns {string}
 */
function statusFromTag(tag) {
  const text = str(tag);
  if (!text.startsWith('dsh:')) return '';
  const rest = text.slice(4);
  const cut = rest.indexOf(':');
  return (cut >= 0 ? rest.slice(0, cut) : rest).trim();
}

/**
 * Default headers merged with `target.headers`; the target wins, and the match
 * is case-insensitive so a custom `Content-Type` never produces a duplicate.
 * @param {unknown} custom
 * @returns {Record<string,string>}
 */
function buildHeaders(custom) {
  /** @type {Record<string,string>} */
  const headers = { 'content-type': JSON_CONTENT_TYPE };
  if (!isRecord(custom)) return headers;
  for (const [rawKey, rawValue] of Object.entries(custom)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key || rawValue === undefined || rawValue === null) continue;
    const lower = key.toLowerCase();
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === lower) delete headers[existing];
    }
    headers[key] = typeof rawValue === 'string' ? rawValue : String(rawValue);
  }
  return headers;
}

/**
 * @param {unknown} value
 * @returns {string|number|null} `null` when the target has no usable chat id.
 */
function normalizeChatId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 64 KiB body cap
 * ------------------------------------------------------------------ */

/**
 * Serialize `body`, keeping the result valid JSON and at most 64 KiB.
 *
 * Strategy: **shrink the largest string leaf in place** (binary search over its
 * length, `…` appended) and repeat with the next-largest leaf while the encoded
 * form is still too large. No field is added or removed, so the provider wire
 * shape is preserved and every other field survives verbatim. Only if that
 * structural shrink cannot get under the cap (not reachable through the
 * builders above, but defended) does it fall back to **plain-slicing the
 * longest text** into a minimal `{ source, truncated, text }` envelope, which is
 * still valid JSON.
 *
 * @param {Record<string, unknown>} body
 * @returns {string}
 */
function fitBody(body) {
  try {
    let json = JSON.stringify(body);
    if (byteLength(json) <= MAX_BODY_BYTES) return json;

    const leaves = collectStringLeaves(body).sort((a, b) => b.bytes - a.bytes);
    for (const leaf of leaves) {
      json = JSON.stringify(body);
      if (byteLength(json) <= MAX_BODY_BYTES) return json;
      shrinkLeaf(body, leaf);
    }

    json = JSON.stringify(body);
    if (byteLength(json) <= MAX_BODY_BYTES) return json;
    return plainSliceFallback(body);
  } catch {
    return plainSliceFallback(body);
  }
}

/**
 * Binary-search the longest prefix of one string leaf that keeps the whole
 * encoded body under the cap, then write it back with an ellipsis.
 * @param {Record<string, unknown>} root
 * @param {{ owner: Record<string, any>, key: string }} leaf
 */
function shrinkLeaf(root, leaf) {
  const value = str(leaf.owner[leaf.key]);
  if (!value) return;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    leaf.owner[leaf.key] = `${sliceChars(value, mid)}${ELLIPSIS}`;
    if (byteLength(JSON.stringify(root)) <= MAX_BODY_BYTES) low = mid;
    else high = mid - 1;
  }
  leaf.owner[leaf.key] = `${sliceChars(value, low)}${ELLIPSIS}`;
}

/**
 * Last resort: slice the longest text into a minimal envelope that is
 * guaranteed to fit because its own length is binary-searched to zero.
 * @param {Record<string, unknown>} body
 * @returns {string}
 */
function plainSliceFallback(body) {
  const leaves = collectStringLeaves(body).sort((a, b) => b.bytes - a.bytes);
  const seed = leaves.length ? str(leaves[0].owner[leaves[0].key]) : '';
  const envelope = { source: 'dsh-notification-hook', truncated: true, text: '' };
  let low = 0;
  let high = seed.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    envelope.text = sliceChars(seed, mid);
    if (byteLength(JSON.stringify(envelope)) <= MAX_BODY_BYTES) low = mid;
    else high = mid - 1;
  }
  envelope.text = sliceChars(seed, low);
  return JSON.stringify(envelope);
}

/**
 * Every writable string leaf of an object graph, deepest-first safe (cycles are
 * skipped).
 * @param {unknown} root
 * @returns {Array<{ owner: Record<string, any>, key: string, bytes: number }>}
 */
function collectStringLeaves(root) {
  /** @type {Array<{ owner: Record<string, any>, key: string, bytes: number }>} */
  const leaves = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) visit(node, String(index), node[index], leaves, walk);
      return;
    }
    for (const [key, value] of Object.entries(node)) visit(node, key, value, leaves, walk);
  };
  walk(root);
  return leaves;
}

/**
 * @param {Record<string, any>} owner
 * @param {string} key
 * @param {unknown} value
 * @param {Array<{ owner: Record<string, any>, key: string, bytes: number }>} leaves
 * @param {(node: unknown) => void} walk
 */
function visit(owner, key, value, leaves, walk) {
  if (typeof value === 'string') leaves.push({ owner, key, bytes: byteLength(value) });
  else walk(value);
}

/* ------------------------------------------------------------------ *
 * primitives
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
 * @param {...unknown} values
 * @returns {string} the first non-empty string.
 */
function firstString(...values) {
  for (const value of values) {
    const text = str(value).trim();
    if (text) return text;
  }
  return '';
}

/**
 * @param {string} value
 * @returns {number} UTF-8 byte length.
 */
function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * `String.prototype.slice` that never splits a surrogate pair.
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
function sliceChars(value, maxChars) {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  let end = maxChars;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/**
 * @param {unknown} value
 * @returns {string} ISO-8601 instant; epoch 0 when the input carries no usable time.
 */
function toIsoString(value) {
  const candidate =
    value instanceof Date
      ? value
      : new Date(typeof value === 'number' || typeof value === 'string' ? value : Number.NaN);
  const time = candidate.getTime();
  return new Date(Number.isFinite(time) ? time : 0).toISOString();
}

/**
 * @param {unknown} value
 * @returns {URL|null}
 */
function parseUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
