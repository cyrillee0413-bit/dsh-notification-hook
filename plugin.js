/**
 * Notification & Webhook Hook — the Cordis host half.
 *
 * Watches the committed session feed and the user-question waterfall, then announces the
 * three states a user actually misses while a long task runs in the background:
 * `completed`, `failed`, and `awaiting-input` (a permission prompt or a question).
 * Delivery is a native desktop notification, an HTTP POST to any of Feishu / WeCom /
 * Telegram / Discord / Slack / a generic JSON endpoint, or both.
 *
 * Zero external dependencies: `node:*` builtins only, plus a best-effort optional
 * schemastery import that only improves the profile's Config projection.
 * @module dsh-notification-hook
 */

import { createConfigSchema, normalizeConfig } from './lib/config.js';
import { Notifier } from './lib/dispatch.js';
import { buildRequest, redactUrl } from './lib/payloads.js';
import { postJson } from './lib/http.js';
import { notifyDesktop } from './lib/desktop.js';

export const name = 'notifyHook';

/** No required services: the plugin observes core events only, so it composes anywhere. */
export const inject = [];

/**
 * `@deepseek-ai/schemastery` is a real dependency, and it is what buys the in-UI Save button:
 * `@deepseek-ai/dsh-settings` projects a row as a live settings namespace only when its Config
 * is a native schema *and* that schema is `.volatile()`. Without it the plugin still runs and
 * behaves identically, but the settings panel can only generate a config block to paste.
 */
async function loadSchemastery() {
  try {
    const mod = await import('@deepseek-ai/schemastery');
    const Schema = mod?.default ?? mod;
    return Schema && typeof Schema.object === 'function' ? Schema : undefined;
  } catch {
    return undefined;
  }
}

export const Config = createConfigSchema(await loadSchemastery());

/** @param {unknown} error */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Remove any URL-shaped token before an error reaches a host log line. */
function safeDeliveryError(error) {
  return messageOf(error).replace(/https?:\/\/\S+/gi, '[redacted URL]').slice(0, 300);
}

/**
 * Read DSH's own durable language preference from the official Settings service.
 * `auto` means DSH deliberately follows the operating system/browser. `null` means
 * the Settings service or locale namespace is unavailable, which is the only case
 * where the legacy plugin locale remains the compatibility fallback.
 * @param {any} settings
 * @returns {'auto'|'zh'|'en'|null}
 */
function readDshLocale(settings) {
  try {
    const rows = settings?.describe?.();
    if (!Array.isArray(rows)) return null;
    const row = rows.find((entry) => entry?.ns === 'locale' || String(entry?.ns ?? '').endsWith(':locale'));
    if (!row) return null;
    const value = String(row?.value?.preference ?? '').trim().toLowerCase();
    if (value === 'zh' || value.startsWith('zh-')) return 'zh';
    if (value === 'en' || value.startsWith('en-')) return 'en';
    return 'auto';
  } catch (error) {
    log('warn', `could not read DSH locale: ${safeDeliveryError(error)}`);
  }
  return null;
}

/** @param {'error'|'warn'|'info'} level @param {string} text */
function log(level, text) {
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  try {
    sink(`[notify-hook] ${text}`);
  } catch {
    // A missing console must never be the reason a notification is lost.
  }
}

/** @param {object} entry @param {object} config */
function describeDelivery(entry, config) {
  if (entry.kind === 'desktop') {
    return entry.ok ? `desktop(${entry.nativeKind ?? 'native'})=ok` : `desktop=${safeDeliveryError(entry.error ?? 'failed')}`;
  }
  const label = `${entry.name} ${redactUrl(entry.url ?? '')}`.trim();
  if (entry.ok) return `${label}=HTTP ${entry.status}${entry.attempts > 1 ? ` (${entry.attempts} tries)` : ''}`;
  return `${label}=${safeDeliveryError(entry.error ?? `HTTP ${entry.status}`)}`;
}

/**
 * Build the deliver function: one native notification (when enabled) plus one POST per
 * webhook, all in parallel, each failure isolated and reported.
 *
 * Exported so `tools/selftest.mjs` can drive the exact production delivery path without a
 * Cordis host.
 * @param {object} config normalized config
 */
export function createDeliver(config) {
  return async function deliver(signal, notification, meta) {
    const jobs = [];

    if (config.desktop.enabled) {
      jobs.push(
        (async () => {
          try {
            const result = await notifyDesktop(notification, {
              sound: config.desktop.sound,
              appId: config.desktop.appId || undefined,
              timeoutMs: config.desktop.timeoutMs,
            });
            return { kind: 'desktop', nativeKind: result?.kind, ok: result?.ok === true, error: result?.error };
          } catch (error) {
            return { kind: 'desktop', ok: false, error: messageOf(error) };
          }
        })(),
      );
    }

    for (const target of config.webhooks) {
      // A switched-off target is skipped, not reported: it is a deliberate user choice, not a
      // delivery failure, and the settings UI lets one be parked without deleting its URL.
      if (target.enabled === false) continue;
      jobs.push(
        (async () => {
          let request;
          try {
            // The generic body carries signal-derived fields, so the signal travels with the
            // meta rather than widening the provider signature.
            request = buildRequest(target, notification, { ...meta, signal });
          } catch (error) {
            // A malformed target (for example Telegram without chatId) is a config error,
            // not a runtime failure: report it and keep the other targets alive.
            return { kind: 'webhook', name: target.name, url: target.url, ok: false, error: messageOf(error) };
          }
          try {
            const result = await postJson(request, { timeoutMs: config.timeoutMs, retries: config.retries });
            return {
              kind: 'webhook',
              name: target.name,
              url: request.url,
              ok: result.ok === true,
              status: result.status,
              attempts: result.attempts,
              error: result.error,
            };
          } catch (error) {
            return { kind: 'webhook', name: target.name, url: request.url, ok: false, error: messageOf(error) };
          }
        })(),
      );
    }

    const settled = await Promise.allSettled(jobs);
    const results = settled.map((entry) =>
      entry.status === 'fulfilled'
        ? entry.value
        : { kind: 'unknown', ok: false, error: messageOf(entry.reason) },
    );

    if (config.logDeliveries) {
      const summary = results.map((entry) => describeDelivery(entry, config)).join(', ');
      if (summary) log('info', summary);
    }

    return {
      desktop: results.find((entry) => entry.kind === 'desktop'),
      webhooks: results.filter((entry) => entry.kind === 'webhook'),
    };
  };
}

/**
 * Activate the plugin.
 * @param {any} ctx Cordis context of the loader row.
 * @param {unknown} config raw row config; normalized here.
 */
export function apply(ctx, config) {
  // DSH commits a root-volatile settings edit into this stable reference and emits
  // `loader/volatile-update`; it deliberately does not remount the plugin. Read through
  // the reference on every such event instead of freezing the activation-time snapshot.
  let dshLocale = null;
  const readConfig = () => {
    const normalized = normalizeConfig(typeof config?.get === 'function' ? config.get() : config);
    return dshLocale !== null ? { ...normalized, locale: dshLocale } : normalized;
  };
  let resolved;
  let notifier;
  let disposed = false;
  let testWasArmed = false;

  const replaceNotifier = () => {
    const previous = notifier;
    resolved = readConfig();
    notifier = resolved.enabled
      ? new Notifier({ config: resolved, deliver: createDeliver(resolved), log })
      : undefined;
    if (previous) previous.dispose().catch((error) => log('error', `reconfigure dispose failed: ${messageOf(error)}`));

    if (!resolved.enabled) {
      log('info', 'disabled by config (enabled: false); delivery paused');
    } else {
      log(
        'info',
        `active (desktop=${resolved.desktop.enabled ? 'on' : 'off'}, `
          + `webhooks=${resolved.webhooks.length}, locale=${resolved.locale}, `
          + `minDuration=${resolved.minDurationMs}ms, awaitingInputDelay=${resolved.awaitingInputDelayMs}ms)`,
      );
    }

    if (notifier && resolved.testOnActivate && !testWasArmed) {
      notifier.publish({ title: 'DSH notify-hook activated' });
    }
    testWasArmed = resolved.testOnActivate;
  };

  // The browser and this Host plugin share DSH's `locale` preference through the
  // official Settings service. Optional injection keeps the notifier usable in a
  // minimal Cordis composition; once Settings appears, its language wins over the
  // legacy per-plugin locale and later DSH language changes rebuild delivery live.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (child) => {
      const syncDshLocale = () => {
        const next = readDshLocale(child.settings);
        if (next === dshLocale) return;
        dshLocale = next;
        if (!disposed && resolved !== undefined) replaceNotifier();
      };
      syncDshLocale();
      child.on('settings/document-updated', (ns) => {
        if (ns === 'locale' || String(ns ?? '').endsWith(':locale')) syncDshLocale();
      }, { global: true });
    });
  } else {
    dshLocale = readDshLocale(ctx.settings);
  }

  replaceNotifier();

  // Note: `ctx.settings.configure({ auto: false })` is deliberately NOT called. It reads as if it
  // would suppress a duplicate harness-rendered form, but no client code consumes `autoGenerate`
  // (only the settings service, its controller and the remote schema mention it), so it changed
  // nothing observable while adding an optional-service dependency and a failure path. The
  // harness' own config form for this row is welcome: it is rendered from the schema this plugin
  // already publishes, which makes it a useful fallback when the custom page lags behind.

  // Teardown is owned by the row: unloading the plugin stops every hold and delivery.
  ctx.effect(() => async () => {
    disposed = true;
    if (notifier) await notifier.dispose().catch((error) => log('error', `dispose failed: ${messageOf(error)}`));
  }, 'notify-hook.dispatcher');

  ctx.on('session/event', (session, event) => notifier?.onSessionEvent(session, event), { global: true });

  // A waterfall listener must always delegate: this plugin observes, it never answers.
  ctx.on(
    'user-questions/request',
    function (request, next) {
      notifier?.onUserQuestion(this, request);
      return next();
    },
    { global: true },
  );

  ctx.on('loader/volatile-update', () => {
    if (!disposed) replaceNotifier();
  });

  ctx.provide('notifyHook', {
    /** Delivery counters for diagnostics. */
    stats: () => notifier?.stats() ?? {
      delivered: 0,
      failed: 0,
      skipped: 0,
      byStatus: {},
      bySkipReason: {},
      pending: 0,
      inflight: 0,
      trackedSessions: 0,
      dedupeEntries: 0,
    },
    /** Deliver every held notification immediately. */
    flush: () => notifier?.flush() ?? Promise.resolve(),
    /** Send one synthetic notification through the real pipeline. */
    test: (overrides) => notifier?.publish({ title: 'DSH notify-hook test', ...overrides }),
  });
}
