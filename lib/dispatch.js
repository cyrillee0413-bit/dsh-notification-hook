/**
 * Signal gating and fan-out.
 *
 * `Notifier` is deliberately free of Cordis, timers and sockets: it receives a config, a
 * `deliver` function, a clock and a scheduler. That keeps every rule below testable without
 * a host process, and keeps the plugin's event wiring thin enough to read in one screen.
 * @module dsh-notification-hook/dispatch
 */

import { EVENT_KEY_BY_STATUS, normalizeConfig } from './config.js';
import { classifySessionEvent, classifyUserQuestion, decidedApprovalId, describeSignal } from './classify.js';
import { formatNotification, resolveLocale } from './format.js';

const DEFAULT_SCHEDULER = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

const LEVEL_RANK = { silent: 0, error: 1, warn: 2, info: 3 };

/** Statuses that are announced immediately, regardless of how short the turn was. */
const ALWAYS_ANNOUNCED = new Set(['failed', 'awaiting-input', 'attention']);

/** Session events kept when replaying a bounded tail to recover a session title. */
const TITLE_SCAN_WINDOW = 500;

/** @param {unknown} value */
function basename(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/[\\/]+$/, '');
  if (!trimmed) return undefined;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || undefined;
}

/** @param {any} owner a Session or an Agent; both carry the session id. */
function sessionIdOf(owner) {
  const direct = owner?.id;
  if (typeof direct === 'string' && direct) return direct;
  const viaHeader = owner?.header?.id;
  if (typeof viaHeader === 'string' && viaHeader) return viaHeader;
  return '-';
}

export class Notifier {
  /**
   * @param {object} deps
   * @param {unknown} deps.config raw or normalized plugin config.
   * @param {(signal: object, notification: object, meta: object) => Promise<unknown>} deps.deliver
   * @param {(level: 'error'|'warn'|'info', message: string) => void} [deps.log]
   * @param {() => number} [deps.now]
   * @param {{setTimeout: Function, clearTimeout: Function}} [deps.scheduler]
   */
  constructor({ config, deliver, log, now, scheduler } = {}) {
    this.config = normalizeConfig(config);
    this.deliver = typeof deliver === 'function' ? deliver : async () => undefined;
    this.log = typeof log === 'function' ? log : () => undefined;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.scheduler = scheduler ?? DEFAULT_SCHEDULER;

    /** @type {Map<string, string>} */
    this.titles = new Map();
    /** @type {Map<string, {turn?: number, startedAt: number}>} */
    this.openTurns = new Map();
    /** @type {Set<string>} */
    this.subagentSessions = new Set();
    /** @type {Map<string, {timer: unknown, signal: object, meta: object}>} */
    this.pending = new Map();
    /** @type {Map<string, number>} */
    this.recent = new Map();
    /** @type {Set<Promise<unknown>>} */
    this.inflight = new Set();

    this.counters = { delivered: 0, failed: 0, skipped: 0, byStatus: {}, bySkipReason: {} };
    this.disposed = false;
  }

  // ---------------------------------------------------------------- event entry points

  /**
   * Feed one committed session event. Never throws: a notification plugin must not be
   * able to break the session feed it observes.
   * @param {any} session
   * @param {any} event
   */
  onSessionEvent(session, event) {
    try {
      if (this.disposed) return;
      const sessionId = sessionIdOf(session);
      const header = session?.header ?? {};
      if (header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)) {
        this.subagentSessions.add(sessionId);
      }
      const type = event?.type;
      if (type === 'session/title') {
        const title = event?.data?.title;
        if (typeof title === 'string' && title.trim()) this.titles.set(sessionId, title.trim());
        return;
      }
      if (type === 'turn/start') {
        const turn = event?.data?.turn;
        this.openTurns.set(sessionId, {
          turn: typeof turn === 'number' ? turn : undefined,
          startedAt: Number.isFinite(event?.time) ? event.time : this.now(),
        });
        return;
      }
      if (type === 'approval/decided') {
        this.#settlePending(sessionId, decidedApprovalId(event));
        return;
      }
      const signal = classifySessionEvent(event);
      if (!signal) return;
      this.#handle(signal, session, sessionId);
    } catch (error) {
      this.#log('error', `notify-hook: session event failed: ${messageOf(error)}`);
    }
  }

  /**
   * Feed one `user-questions/request`. The turn is still open and the agent is blocked on
   * the user, which is exactly the state this plugin exists to surface.
   * @param {any} agent
   * @param {any} request
   */
  onUserQuestion(agent, request) {
    try {
      if (this.disposed) return;
      const sessionId = sessionIdOf(agent);
      const signal = classifyUserQuestion(request, { sessionId });
      if (!signal) return;
      this.#handle(signal, { id: sessionId, header: {} }, sessionId);
    } catch (error) {
      this.#log('error', `notify-hook: user question failed: ${messageOf(error)}`);
    }
  }

  // ---------------------------------------------------------------- pipeline

  /** @param {object} signal @param {any} session @param {string} sessionId */
  #handle(signal, session, sessionId) {
    // Any fresh notify-worthy state means an earlier "still waiting" state is over.
    if (this.pending.has(sessionId)) this.#settlePending(sessionId);

    const header = session?.header ?? {};
    if (this.#isSubagent(sessionId, header) && !this.config.includeSubagents) {
      return this.#skip('subagent-session');
    }

    const eventKey = EVENT_KEY_BY_STATUS[signal.status];
    if (!eventKey || this.config.events[eventKey] !== true) return this.#skip(`status:${signal.status}`);

    let durationMs;
    if (signal.eventType === 'turn/end') {
      const open = this.openTurns.get(sessionId);
      this.openTurns.delete(sessionId);
      if (open && Number.isFinite(open.startedAt)) {
        const sameTurn = open.turn === undefined || signal.turn === undefined || open.turn === signal.turn;
        if (sameTurn) durationMs = Math.max(0, signal.at - open.startedAt);
      }
    }

    if (
      typeof durationMs === 'number'
      && this.config.minDurationMs > 0
      && !ALWAYS_ANNOUNCED.has(signal.status)
      && durationMs < this.config.minDurationMs
    ) {
      return this.#skip('below-min-duration');
    }

    const meta = this.#meta(session, sessionId, durationMs);
    if (signal.status === 'awaiting-input' && this.config.awaitingInputDelayMs > 0) {
      return this.#holdPending(sessionId, signal, meta);
    }
    this.#emit(signal, meta);
  }

  /** @param {string} sessionId @param {object} signal @param {object} meta */
  #holdPending(sessionId, signal, meta) {
    const previous = this.pending.get(sessionId);
    if (previous) this.scheduler.clearTimeout(previous.timer);
    const timer = this.scheduler.setTimeout(() => {
      this.pending.delete(sessionId);
      this.#emit(signal, meta);
    }, this.config.awaitingInputDelayMs);
    if (typeof timer?.unref === 'function') timer.unref();
    this.pending.set(sessionId, { timer, signal, meta });
  }

  /**
   * Drop a held awaiting-input notification. When `approvalId` is given only the matching
   * hold is dropped, so a decided permission prompt never notifies while a separate
   * question stays pending.
   * @param {string} sessionId
   * @param {string} [approvalId]
   */
  #settlePending(sessionId, approvalId) {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    if (approvalId && entry.signal.approvalId && approvalId !== entry.signal.approvalId) return;
    this.scheduler.clearTimeout(entry.timer);
    this.pending.delete(sessionId);
    this.#skip(approvalId ? 'resolved-before-notify' : 'superseded');
  }

  /** @param {object} signal @param {object} meta */
  #emit(signal, meta) {
    const key = `${meta.sessionId}|${signal.dedupeKey}`;
    const at = this.now();
    const seenAt = this.recent.get(key);
    if (seenAt !== undefined && at - seenAt < this.config.dedupeWindowMs) return this.#skip('duplicate');
    this.recent.set(key, at);
    this.#pruneRecent(at);

    const notification = formatNotification(signal, meta, { locale: this.#locale() });
    this.counters.byStatus[signal.status] = (this.counters.byStatus[signal.status] ?? 0) + 1;

    const settled = Promise.resolve()
      .then(() => this.deliver(signal, notification, meta))
      .then((outcome) => {
        this.counters.delivered += 1;
        this.#log('info', `notify-hook: ${describeSignal(signal)} delivered ${summarizeOutcome(outcome)}`);
      })
      .catch((error) => {
        this.counters.failed += 1;
        this.#log('error', `notify-hook: ${describeSignal(signal)} delivery failed: ${messageOf(error)}`);
      })
      .finally(() => {
        this.inflight.delete(settled);
      });
    this.inflight.add(settled);
  }

  // ---------------------------------------------------------------- manual entry points

  /**
   * Publish a synthetic signal through the same gates, formatter and fan-out as a real one.
   * Used by the activation self-test and by the `notifyHook.test()` service.
   * @param {Partial<{status: string, title: string, eventType: string, errorMessage: string, question: string}>} [overrides]
   * @returns {object} the signal that was published.
   */
  publish(overrides = {}) {
    const at = this.now();
    const signal = {
      status: 'completed',
      source: 'session-event',
      eventType: 'notify-hook/test',
      at,
      dedupeKey: `notify-hook/test:${at}`,
      ...overrides,
    };
    const meta = {
      sessionId: 'notify-hook',
      title: overrides.title ?? 'DSH notify-hook',
      project: 'DSH',
      isSubagent: false,
    };
    if (this.disposed) return signal;
    this.#emit(signal, meta);
    return signal;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Run every held notification now, then await in-flight deliveries. */
  async flush() {
    for (const [sessionId, entry] of [...this.pending]) {
      this.scheduler.clearTimeout(entry.timer);
      this.pending.delete(sessionId);
      this.#emit(entry.signal, entry.meta);
    }
    await Promise.allSettled([...this.inflight]);
  }

  async dispose() {
    if (this.disposed) return;
    await this.flush();
    this.disposed = true;
    for (const entry of this.pending.values()) this.scheduler.clearTimeout(entry.timer);
    this.pending.clear();
    this.openTurns.clear();
    this.recent.clear();
  }

  stats() {
    return {
      ...this.counters,
      pending: this.pending.size,
      inflight: this.inflight.size,
      trackedSessions: this.titles.size,
      dedupeEntries: this.recent.size,
    };
  }

  // ---------------------------------------------------------------- helpers

  #isSubagent(sessionId, header) {
    if (header?.origin === 'subagent') return true;
    if (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) return true;
    return this.subagentSessions.has(sessionId);
  }

  #locale() {
    return resolveLocale(this.config.locale);
  }

  /** @param {any} session @param {string} sessionId @param {number} [durationMs] */
  #meta(session, sessionId, durationMs) {
    const header = session?.header ?? {};
    const cwd = typeof header.cwd === 'string' && header.cwd ? header.cwd : undefined;
    return {
      sessionId,
      title: this.#title(session, sessionId),
      cwd,
      project: basename(cwd),
      durationMs,
      isSubagent: this.#isSubagent(sessionId, header),
    };
  }

  /**
   * Prefer a title seen live; otherwise replay a bounded tail, so a session titled before
   * this plugin was activated still produces a named notification instead of an id.
   * @param {any} session @param {string} sessionId
   */
  #title(session, sessionId) {
    const cached = this.titles.get(sessionId);
    if (cached) return cached;
    try {
      const end = session?.seq;
      if (typeof end === 'number' && Number.isFinite(end) && typeof session?.snapshotEvents === 'function') {
        const events = session.snapshotEvents(Math.max(0, end - TITLE_SCAN_WINDOW), end);
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const candidate = events[index];
          if (candidate?.type !== 'session/title') continue;
          const title = candidate?.data?.title;
          if (typeof title === 'string' && title.trim()) {
            this.titles.set(sessionId, title.trim());
            return title.trim();
          }
        }
      }
    } catch {
      // A title is decoration; never let a replay failure affect the notification.
    }
    return undefined;
  }

  /** @param {number} at */
  #pruneRecent(at) {
    const window = Math.max(this.config.dedupeWindowMs, 1000);
    if (this.recent.size < 512) return;
    for (const [key, seenAt] of this.recent) {
      if (at - seenAt > window) this.recent.delete(key);
      if (this.recent.size < 512) break;
    }
  }

  /** @param {string} reason */
  #skip(reason) {
    this.counters.skipped += 1;
    this.counters.bySkipReason[reason] = (this.counters.bySkipReason[reason] ?? 0) + 1;
  }

  /** @param {'error'|'warn'|'info'} level @param {string} text */
  #log(level, text) {
    const configured = LEVEL_RANK[this.config.logLevel] ?? LEVEL_RANK.info;
    if ((LEVEL_RANK[level] ?? LEVEL_RANK.info) > configured) return;
    if (level === 'info' && !this.config.logDeliveries) return;
    try {
      this.log(level, text);
    } catch {
      // Logging must never be the reason a notification is lost.
    }
  }
}

/** @param {unknown} error */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** @param {unknown} outcome */
function summarizeOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return '';
  const parts = [];
  const record = /** @type {Record<string, any>} */ (outcome);
  if (record.desktop) parts.push(`desktop=${record.desktop.ok ? 'ok' : record.desktop.error ?? 'failed'}`);
  if (Array.isArray(record.webhooks)) {
    for (const entry of record.webhooks) {
      parts.push(`${entry?.name ?? 'webhook'}=${entry?.ok ? entry.status : entry?.error ?? 'failed'}`);
    }
  }
  return parts.length ? `(${parts.join(', ')})` : '';
}
