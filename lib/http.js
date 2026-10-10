/**
 * lib/http.js — zero-dependency JSON POST transport (owner C).
 *
 * Only `node:http` / `node:https` are used: no `fetch`, no `undici`, no third-party client.
 * `postJson` **never rejects**; every failure path resolves to
 * `{ ok: false, status: 0, error }` (HTTP-level failures keep their real `status`).
 *
 * @module notifyHook/http
 */

import http from 'node:http';
import https from 'node:https';

/**
 * A prepared request, exactly as `lib/payloads.js#buildRequest` returns it. A raw
 * `{ url, method, headers, body }` object is accepted as well.
 *
 * @typedef {object} HttpRequest
 * @property {string} url                          absolute `http:`/`https:` URL
 * @property {string} [method]                     defaults to `POST`
 * @property {Record<string, string>} [headers]    merged headers
 * @property {string} [body]                       request payload (already serialized)
 */

/**
 * @typedef {object} HttpPostOptions
 * @property {number} [timeoutMs]     per-attempt socket timeout in ms, default 8000 (0 disables)
 * @property {number} [retries]       extra attempts after the first one, default 1
 * @property {number} [retryDelayMs]  pause between attempts in ms, default 500
 * @property {number} [maxBodyBytes]  response body cap in bytes, default 65536
 * @property {AbortSignal} [signal]   aborts the whole operation (`error: 'aborted'`)
 */

/**
 * @typedef {object} HttpResult
 * @property {boolean} ok       true only for a 2xx response
 * @property {number} status    HTTP status, or 0 when no response was received
 * @property {string} body      (possibly truncated) response body
 * @property {string} [error]   human-readable failure description
 * @property {number} attempts  number of real HTTP attempts that were started
 */

/** @type {number} */
export const DEFAULT_TIMEOUT_MS = 8000;
/** @type {number} */
export const DEFAULT_RETRIES = 1;
/** @type {number} */
export const DEFAULT_RETRY_DELAY_MS = 500;
/** @type {number} */
export const DEFAULT_MAX_BODY_BYTES = 65536;

/** Hard ceiling for `options.retries` so a hostile config cannot spin forever. */
const MAX_RETRIES = 20;

/**
 * Normalize user options. Never throws: garbage input falls back to the defaults.
 *
 * @param {HttpPostOptions} [options]
 * @returns {{ timeoutMs: number, retries: number, retryDelayMs: number, maxBodyBytes: number,
 *             signal: AbortSignal | undefined }}
 */
export function resolveRequestOptions(options = {}) {
  const raw = options && typeof options === 'object' ? options : {};
  return {
    timeoutMs: toCount(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 0),
    retries: Math.min(toCount(raw.retries, DEFAULT_RETRIES, 0), MAX_RETRIES),
    retryDelayMs: toCount(raw.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 0),
    maxBodyBytes: toCount(raw.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 0),
    signal: isAbortSignal(raw.signal) ? raw.signal : undefined,
  };
}

/**
 * POST a prepared JSON request with bounded retries.
 *
 * Retries happen only for transport errors, HTTP 5xx and HTTP 429 — never for
 * 2xx/3xx/4xx and never after an abort.
 *
 * @param {HttpRequest} request
 * @param {HttpPostOptions} [options]
 * @returns {Promise<HttpResult>} never rejects
 */
export async function postJson(request, options = {}) {
  const opts = resolveRequestOptions(options);
  let attempts = 0;

  try {
    const target = normalizeRequest(request);
    const maxAttempts = opts.retries + 1;
    /** @type {{ status: number, body: string, error?: string, retryable?: boolean }} */
    let last = { status: 0, body: '', error: 'no attempt was started' };

    for (let index = 0; index < maxAttempts; index += 1) {
      if (isAborted(opts.signal)) return failure('aborted', attempts);

      attempts += 1;
      last = await performAttempt(target, opts);

      if (last.error === 'aborted') return failure('aborted', attempts);

      if (last.error) {
        // A locally rejected request (bad header/options) is deterministic: never retried.
        if (last.retryable === false) return failure(last.error, attempts);
      } else {
        const { status, body } = last;
        if (status >= 200 && status < 300) return { ok: true, status, body, attempts };
        if (!isRetryableStatus(status)) {
          return { ok: false, status, body, error: `HTTP ${status}`, attempts };
        }
      }

      if (index + 1 < maxAttempts) await delay(opts.retryDelayMs, opts.signal);
    }

    if (last.error) return failure(last.error, attempts);
    return { ok: false, status: last.status, body: last.body, error: `HTTP ${last.status}`, attempts };
  } catch (error) {
    // Belt and braces: postJson must never reject.
    return failure(errorMessage(error), attempts);
  }
}

/**
 * @param {string} error
 * @param {number} attempts
 * @returns {HttpResult}
 */
function failure(error, attempts) {
  return { ok: false, status: 0, body: '', error, attempts };
}

/**
 * Validate + normalize the incoming request description.
 *
 * @param {HttpRequest} request
 * @returns {{ transport: typeof http | typeof https, options: import('node:http').RequestOptions,
 *             body: string }}
 */
function normalizeRequest(request) {
  const raw = request && typeof request === 'object' ? request : {};
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url) throw new Error('invalid url: request.url is required');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // The URL may contain webhook credentials in its authority, path or query. A
    // validation error is safe to log only when it describes the field, never the
    // rejected value.
    throw new Error('invalid url: request.url could not be parsed');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }

  const body = typeof raw.body === 'string' ? raw.body : raw.body == null ? '' : String(raw.body);
  const headers = normalizeHeaders(raw.headers);
  if (body !== '' && !hasHeader(headers, 'content-length')) {
    headers['content-length'] = String(Buffer.byteLength(body));
  }

  const method =
    typeof raw.method === 'string' && raw.method.trim() !== '' ? raw.method.trim().toUpperCase() : 'POST';

  /** @type {import('node:http').RequestOptions} */
  const requestOptions = {
    protocol: parsed.protocol,
    hostname: hostnameOf(parsed),
    port: parsed.port === '' ? undefined : Number(parsed.port),
    path: `${parsed.pathname}${parsed.search}`,
    method,
    headers,
  };
  if (parsed.username || parsed.password) {
    requestOptions.auth = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  }

  return { transport: parsed.protocol === 'https:' ? https : http, options: requestOptions, body };
}

/**
 * One real HTTP attempt, bounded by `options.timeoutMs` and `options.signal`.
 * `retryable: false` marks a locally rejected request (bad header value, bad options),
 * which will never succeed on a retry.
 *
 * @param {{ transport: typeof http | typeof https, options: import('node:http').RequestOptions,
 *           body: string }} target
 * @param {ReturnType<typeof resolveRequestOptions>} opts
 * @returns {Promise<{ status: number, body: string, error?: string, retryable?: boolean }>}
 */
function performAttempt(target, opts) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    /** @type {import('node:http').ClientRequest | null} */
    let req = null;
    const { signal } = opts;

    /** @param {{ status: number, body: string, error?: string, retryable?: boolean }} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    function onAbort() {
      if (req) {
        try {
          req.destroy(new Error('aborted'));
        } catch {
          /* already gone */
        }
      }
      finish({ status: 0, body: '', error: 'aborted' });
    }

    if (isAborted(signal)) {
      finish({ status: 0, body: '', error: 'aborted' });
      return;
    }

    try {
      req = target.transport.request(target.options);
    } catch (error) {
      // The request never reached the network: retrying cannot help.
      finish({ status: 0, body: '', error: errorMessage(error), retryable: false });
      return;
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (opts.timeoutMs > 0) {
      req.setTimeout(opts.timeoutMs, () => {
        const message = `timeout after ${opts.timeoutMs}ms`;
        try {
          req?.destroy(new Error('timeout'));
        } catch {
          /* already gone */
        }
        finish({ status: 0, body: '', error: message });
      });
    }

    req.on('error', (error) => finish({ status: 0, body: '', error: errorMessage(error) }));
    req.on('response', (res) => collectBody(res, opts, finish));

    try {
      req.end(target.body === '' ? undefined : target.body);
    } catch (error) {
      try {
        req.destroy();
      } catch {
        /* already gone */
      }
      finish({ status: 0, body: '', error: errorMessage(error) });
    }
  });
}

/**
 * Read the response body, capped at `opts.maxBodyBytes`; the remainder of the stream is
 * discarded and the response destroyed so the socket is not held open.
 *
 * @param {import('node:http').IncomingMessage} res
 * @param {ReturnType<typeof resolveRequestOptions>} opts
 * @param {(result: { status: number, body: string, error?: string }) => void} finish
 */
function collectBody(res, opts, finish) {
  const status = Number.isInteger(res.statusCode) ? /** @type {number} */ (res.statusCode) : 0;
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  let done = false;

  const complete = () => {
    if (done) return;
    done = true;
    finish({ status, body: Buffer.concat(chunks).toString('utf8') });
  };

  res.on('data', (chunk) => {
    if (done) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const room = opts.maxBodyBytes - size;
    if (room <= 0) {
      try {
        res.destroy();
      } catch {
        /* already gone */
      }
      complete();
      return;
    }
    if (buffer.length > room) {
      chunks.push(buffer.subarray(0, room));
      size += room;
      try {
        res.destroy();
      } catch {
        /* already gone */
      }
      complete();
      return;
    }
    chunks.push(buffer);
    size += buffer.length;
  });

  res.on('end', complete);
  res.on('error', complete);
  res.on('close', () => {
    if (done) return;
    if (res.complete === false) {
      done = true;
      finish({ status: 0, body: '', error: 'connection closed before the response completed' });
      return;
    }
    complete();
  });
}

/**
 * @param {string} text
 * @returns {string}
 */
function hostnameOf(parsed) {
  const { hostname } = parsed;
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * @param {Record<string, string> | undefined} headers
 * @returns {Record<string, string>}
 */
function normalizeHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof name !== 'string' || name === '' || value === undefined || value === null) continue;
    out[name] = typeof value === 'string' ? value : String(value);
  }
  return out;
}

/**
 * @param {Record<string, string>} headers
 * @param {string} name
 * @returns {boolean}
 */
function hasHeader(headers, name) {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

/**
 * @param {number} status
 * @returns {boolean}
 */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * @param {unknown} signal
 * @returns {signal is AbortSignal}
 */
function isAbortSignal(signal) {
  return (
    !!signal &&
    typeof signal === 'object' &&
    typeof (/** @type {AbortSignal} */ (signal).aborted) === 'boolean' &&
    typeof (/** @type {AbortSignal} */ (signal).addEventListener) === 'function'
  );
}

/**
 * @param {AbortSignal | undefined} signal
 * @returns {boolean}
 */
function isAborted(signal) {
  return isAbortSignal(signal) && signal.aborted === true;
}

/**
 * Abort-aware pause between attempts.
 *
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    if (!isAbortSignal(signal)) return;
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error) {
    const message = error.message || error.name || 'error';
    const code = /** @type {{ code?: unknown }} */ (error).code;
    if (typeof code === 'string' && code !== '' && !message.includes(code)) return `${code}: ${message}`;
    return message;
  }
  if (typeof error === 'string' && error !== '') return error;
  return 'unknown error';
}

/**
 * Coerce to a finite, non-negative integer count.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @returns {number}
 */
function toCount(value, fallback, min) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback;
  return Math.max(min, Math.trunc(number));
}
