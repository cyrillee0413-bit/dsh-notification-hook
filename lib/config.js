/**
 * Plugin configuration: canonical defaults, a dependency-free normalizer, and the
 * Standard Schema the host validates the row's `config` with.
 *
 * `normalizeConfig` is authoritative and total: it never throws and always returns a complete
 * shape, so a malformed option degrades to its default instead of blocking activation.
 * {@link createConfigSchema} wraps it in the `~standard` interface Cordis calls; no schema
 * library is imported, and `createConfigSchema` takes no argument by design.
 * @module dsh-notification-hook/config
 */

/** Canonical defaults. The normalized config always contains exactly these keys. */
export const DEFAULTS = Object.freeze({
  /** Master switch. `false` keeps the row loaded but silent. */
  enabled: true,
  /**
   * Legacy notification-language fallback. DSH's global preference wins when available;
   * `auto` otherwise follows the operating-system locale. Kept for profile compatibility.
   */
  locale: 'auto',
  /** Which outcomes notify. Failures and awaiting-input are the ones users miss. */
  events: Object.freeze({
    completed: true,
    failed: true,
    awaitingInput: true,
    attention: true,
    cancelled: false,
  }),
  /** Notify for subagent sessions too. Off by default: a delegated run is very chatty. */
  includeSubagents: false,
  /**
   * Completed/cancelled turns shorter than this are not announced. Failures and
   * awaiting-input always notify, because losing time to a silent stop is the whole point.
   */
  minDurationMs: 10_000,
  /**
   * How long an "awaiting input" state must persist before it is announced. A permission
   * prompt that resolves itself (or is auto-decided by session policy) stays silent.
   */
  awaitingInputDelayMs: 2_500,
  /** Identical signals within this window are collapsed. */
  dedupeWindowMs: 3_000,
  /** Desktop (native) notification settings. */
  desktop: Object.freeze({
    enabled: true,
    sound: false,
    appId: '',
    timeoutMs: 10_000,
  }),
  /** Webhook targets. Empty by default: an unconfigured plugin must not talk to the network. */
  webhooks: Object.freeze([]),
  /** Per-request webhook timeout. */
  timeoutMs: 8_000,
  /** Extra attempts after the first, for transport errors, 5xx and 429 only. */
  retries: 1,
  /**
   * Host log verbosity: `silent` < `error` < `warn` < `info`. Matched
   * case-insensitively and normalized to lower case.
   */
  logLevel: 'info',
  /** Write one line per delivery attempt to the host log. */
  logDeliveries: true,
  /**
   * Send one test notification as soon as the row activates. Setup aid only: it proves the
   * desktop and webhook paths without waiting for a turn to finish. Off by default so a
   * config reload stays silent.
   */
  testOnActivate: false,
});

const LOCALES = new Set(['auto', 'zh', 'en']);
const LOG_LEVELS = new Set(['silent', 'error', 'warn', 'info']);

/**
 * Coerce an identifier option to its canonical lower-case form before the membership
 * test.
 *
 * The client half displays `locale` and `logLevel` lower-cased, so a case-sensitive
 * test here made the two halves disagree: a row written by hand as `logLevel: SILENT`
 * ran at the host default `info` while the settings panel showed `silent`, and the next
 * Save rewrote the value the user was looking at. Accepting the case the user typed is
 * the forgiving end of that mismatch, and the *stored* form stays lower-cased so
 * everything downstream (and the panel) sees exactly one spelling.
 *
 * @param {unknown} value
 * @param {Set<string>} allowed
 * @param {string} fallback
 */
function identifier(value, allowed, fallback) {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim().toLowerCase();
  return allowed.has(candidate) ? candidate : fallback;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function clampNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** @param {unknown} value @param {boolean} fallback */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** @param {unknown} value @param {string} fallback */
function str(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/** @param {unknown} value */
function normalizeHeaders(value) {
  if (!isPlainObject(value)) return undefined;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') continue;
    const name = String(key).trim();
    // A header name from config must stay a header name: reject CR/LF injection outright.
    if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(String(raw))) continue;
    out[name] = String(raw);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Normalize one webhook entry. Entries without a usable URL are dropped rather than
 * throwing, so one bad row cannot stop the plugin from activating.
 * @param {unknown} raw
 * @param {number} index
 */
function normalizeWebhook(raw, index) {
  if (!isPlainObject(raw)) return undefined;
  const url = str(raw.url, '').trim();
  if (!/^https?:\/\//i.test(url)) return undefined;
  const entry = {
    // Per-target switch: an off target stays configured but is never delivered to, so a user
    // can keep a webhook ready without silencing everything else.
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    name: str(raw.name, '').trim() || `target-${index + 1}`,
    type: str(raw.type, 'auto').trim().toLowerCase(),
    url,
  };
  const chatId = raw.chatId ?? raw.chat_id;
  if (typeof chatId === 'string' && chatId.trim()) entry.chatId = chatId.trim();
  if (typeof chatId === 'number' && Number.isFinite(chatId)) entry.chatId = String(chatId);
  const headers = normalizeHeaders(raw.headers);
  if (headers) entry.headers = headers;
  const events = normalizeEventMap(raw.events);
  if (events) entry.events = events;
  return entry;
}

/** @param {unknown} value */
function normalizeEventMap(value) {
  if (!isPlainObject(value)) return undefined;
  /** @type {Record<string, boolean>} */
  const out = {};
  let seen = false;
  for (const key of Object.keys(DEFAULTS.events)) {
    if (typeof value[key] === 'boolean') {
      out[key] = value[key];
      seen = true;
    }
  }
  return seen ? out : undefined;
}

/**
 * Deep-normalize raw profile config into a complete, validated config object.
 * Never throws and never returns a partially-shaped object.
 * @param {unknown} raw
 */
export function normalizeConfig(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const eventsInput = isPlainObject(input.events) ? input.events : {};
  const desktopInput = isPlainObject(input.desktop) ? input.desktop : {};
  const locale = identifier(input.locale, LOCALES, DEFAULTS.locale);
  const logLevel = identifier(input.logLevel, LOG_LEVELS, DEFAULTS.logLevel);

  const webhooks = Array.isArray(input.webhooks)
    ? input.webhooks.map(normalizeWebhook).filter(Boolean)
    : [];

  return {
    enabled: bool(input.enabled, DEFAULTS.enabled),
    locale,
    logLevel,
    events: {
      completed: bool(eventsInput.completed, DEFAULTS.events.completed),
      failed: bool(eventsInput.failed, DEFAULTS.events.failed),
      awaitingInput: bool(eventsInput.awaitingInput, DEFAULTS.events.awaitingInput),
      attention: bool(eventsInput.attention, DEFAULTS.events.attention),
      cancelled: bool(eventsInput.cancelled, DEFAULTS.events.cancelled),
    },
    includeSubagents: bool(input.includeSubagents, DEFAULTS.includeSubagents),
    minDurationMs: clampNumber(input.minDurationMs, DEFAULTS.minDurationMs, 0, 24 * 60 * 60 * 1000),
    awaitingInputDelayMs: clampNumber(input.awaitingInputDelayMs, DEFAULTS.awaitingInputDelayMs, 0, 60_000),
    dedupeWindowMs: clampNumber(input.dedupeWindowMs, DEFAULTS.dedupeWindowMs, 0, 60_000),
    desktop: {
      enabled: bool(desktopInput.enabled, DEFAULTS.desktop.enabled),
      sound: bool(desktopInput.sound, DEFAULTS.desktop.sound),
      appId: str(desktopInput.appId, DEFAULTS.desktop.appId).trim(),
      timeoutMs: clampNumber(desktopInput.timeoutMs, DEFAULTS.desktop.timeoutMs, 500, 60_000),
    },
    webhooks,
    timeoutMs: clampNumber(input.timeoutMs, DEFAULTS.timeoutMs, 250, 60_000),
    retries: clampNumber(input.retries, DEFAULTS.retries, 0, 3),
    logDeliveries: bool(input.logDeliveries, DEFAULTS.logDeliveries),
    testOnActivate: bool(input.testOnActivate, DEFAULTS.testOnActivate),
  };
}

/** Status key in `config.events` for a signal status. */
export const EVENT_KEY_BY_STATUS = Object.freeze({
  completed: 'completed',
  failed: 'failed',
  'awaiting-input': 'awaitingInput',
  attention: 'attention',
  cancelled: 'cancelled',
});

/**
 * Standard Schema v1 interface over {@link normalizeConfig}.
 *
 * Cordis validates a row's config with `Config['~standard'].validate(raw)` and throws when
 * that member is missing, so a plugin that declares `Config` must expose it. Implementing
 * the standard directly is what keeps this plugin genuinely dependency-free: schemastery is
 * not resolvable from a profile-linked package, and the plugin must activate cleanly anyway.
 *
 * `normalizeConfig` is total, so a malformed option degrades to its default rather than
 * blocking activation — an unparseable notification config should never cost the user the
 * plugin itself.
 *
 * This is the fallback path. When schemastery resolves, {@link createConfigSchema} returns a
 * native volatile schema instead, because that is the only way the harness will expose this row
 * as a live settings namespace. Both paths funnel into the same `normalizeConfig`, so a value
 * means the same thing either way; only *when* a bad value is reported differs.
 */
const STANDARD_SCHEMA = Object.freeze({
  version: 1,
  vendor: 'dsh-notification-hook',
  validate(value) {
    return { value: normalizeConfig(value) };
  },
});

/** The dependency-free schema, used when schemastery is not resolvable. */
function createStandaloneConfig() {
  const schema = (value) => normalizeConfig(value);
  schema['~standard'] = STANDARD_SCHEMA;
  return schema;
}

/**
 * The native schema, used when schemastery resolves.
 *
 * Two properties matter and neither is cosmetic:
 *
 * 1. **The root is `.volatile()`.** `@deepseek-ai/dsh-settings` builds its forms through
 *    `volatileForm()`, which returns nothing unless the schema (or a field) is volatile. A
 *    non-volatile schema never appears in the settings namespace list, so an in-UI Save button
 *    cannot exist. This is the whole reason the dependency is worth carrying.
 * 2. **Fields are typed but not constrained.** Type errors are reported loudly at activation,
 *    so a YAML typo is not silently clamped away, while *semantics* stay with
 *    `normalizeConfig`: `locale`/`logLevel` are plain strings so `'ZH'` is accepted and
 *    lower-cased rather than rejected, and numeric ranges are clamped there too.
 *
 * A volatile root parses into a reference object read with `.get()`; `plugin.js` unwraps it.
 * @param {any} Schema the schemastery default export.
 */
function createSchemasteryConfig(Schema) {
  const { events, desktop } = DEFAULTS;
  return Schema.object({
    enabled: Schema.boolean().default(DEFAULTS.enabled),
    locale: Schema.string().default(DEFAULTS.locale),
    logLevel: Schema.string().default(DEFAULTS.logLevel),
    events: Schema.object({
      completed: Schema.boolean().default(events.completed),
      failed: Schema.boolean().default(events.failed),
      awaitingInput: Schema.boolean().default(events.awaitingInput),
      attention: Schema.boolean().default(events.attention),
      cancelled: Schema.boolean().default(events.cancelled),
    }).default({}),
    includeSubagents: Schema.boolean().default(DEFAULTS.includeSubagents),
    minDurationMs: Schema.number().default(DEFAULTS.minDurationMs),
    awaitingInputDelayMs: Schema.number().default(DEFAULTS.awaitingInputDelayMs),
    dedupeWindowMs: Schema.number().default(DEFAULTS.dedupeWindowMs),
    desktop: Schema.object({
      enabled: Schema.boolean().default(desktop.enabled),
      sound: Schema.boolean().default(desktop.sound),
      appId: Schema.string().default(desktop.appId),
      timeoutMs: Schema.number().default(desktop.timeoutMs),
    }).default({}),
    // Entries are validated by normalizeWebhook, which drops unusable ones. Typing them here
    // would turn one bad target into a refusal to activate the whole plugin.
    webhooks: Schema.array(Schema.any()).default([]),
    timeoutMs: Schema.number().default(DEFAULTS.timeoutMs),
    retries: Schema.number().default(DEFAULTS.retries),
    logDeliveries: Schema.boolean().default(DEFAULTS.logDeliveries),
    testOnActivate: Schema.boolean().default(DEFAULTS.testOnActivate),
  }).volatile();
}

/**
 * Build the profile-facing `Config` schema.
 *
 * With schemastery the row becomes a native volatile schema, which is what makes the harness
 * list it as a settings namespace and lets the Web UI read and write the live configuration.
 * Without it the plugin still activates and behaves identically — every value is normalized by
 * the same `normalizeConfig` — but the panel can only generate a config block to paste.
 * @param {any} Schema schemastery default export, or undefined.
 */
export function createConfigSchema(Schema) {
  if (!Schema || typeof Schema.object !== 'function') return createStandaloneConfig();
  return createSchemasteryConfig(Schema);
}

