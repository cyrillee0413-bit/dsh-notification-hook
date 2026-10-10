/**
 * test/http.test.mjs — owner C.
 *
 * These tests bind real `node:http` servers on `127.0.0.1:0` (no external network) and close
 * every server, and every socket, in the module-level `after()` hook.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { postJson, resolveRequestOptions } from '../lib/http.js';

/** @type {import('node:http').Server[]} */
const servers = [];

/**
 * Start a loopback server on an ephemeral port. The returned `url()` builds absolute URLs.
 *
 * @param {http.RequestListener} handler
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: (path?: string) => string }>}
 */
async function startServer(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    server,
    port: address.port,
    url: (path = '/') => `http://127.0.0.1:${address.port}${path}`,
  };
}

/**
 * Drain a request body and hand it to the handler.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

test('resolveRequestOptions applies the documented defaults', () => {
  assert.deepEqual(resolveRequestOptions(), {
    timeoutMs: 8000,
    retries: 1,
    retryDelayMs: 500,
    maxBodyBytes: 65536,
    signal: undefined,
  });
});

test('resolveRequestOptions clamps garbage instead of throwing', () => {
  assert.deepEqual(resolveRequestOptions(null), resolveRequestOptions(undefined));
  assert.deepEqual(resolveRequestOptions('nope'), resolveRequestOptions());

  const clamped = resolveRequestOptions({ timeoutMs: -10, retries: -3, retryDelayMs: 5.9, maxBodyBytes: 0 });
  assert.equal(clamped.timeoutMs, 0);
  assert.equal(clamped.retries, 0);
  assert.equal(clamped.retryDelayMs, 5);
  assert.equal(clamped.maxBodyBytes, 0);

  const garbage = resolveRequestOptions({ timeoutMs: 'x', retries: Number.NaN, retryDelayMs: null, maxBodyBytes: {} });
  assert.deepEqual(garbage, resolveRequestOptions());
  assert.equal(resolveRequestOptions({ retries: 10_000 }).retries, 20);

  const controller = new AbortController();
  assert.equal(resolveRequestOptions({ signal: controller.signal }).signal, controller.signal);
  assert.equal(resolveRequestOptions({ signal: {} }).signal, undefined);
});

test('malformed credential URLs are rejected without echoing the secret', async () => {
  const secret = 'REVIEW_SECRET';
  const raw = `https://user:${secret}@invalid host/hook`;
  const result = await postJson({ url: raw, body: '{}' }, { retries: 3 });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 0, 'validation must happen before a network attempt');
  assert.equal(result.error.includes(secret), false);
  assert.equal(result.error.includes(raw), false);
});

test('POSTs the request and returns the response body', async () => {
  /** @type {Array<{ method?: string, url?: string, headers: import('node:http').IncomingHttpHeaders, body: string }>} */
  const seen = [];
  const loop = await startServer(async (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: await readBody(req) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });

  const result = await postJson({
    url: loop.url('/hook?token=secret'),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"hello":"世界"}',
  });

  assert.deepEqual(result, { ok: true, status: 200, body: '{"ok":true}', attempts: 1 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/hook?token=secret');
  assert.equal(seen[0].headers['content-type'], 'application/json');
  assert.equal(seen[0].body, '{"hello":"世界"}');
  assert.equal(seen[0].headers['content-length'], String(Buffer.byteLength('{"hello":"世界"}')));
});

test('defaults to POST when the request carries no method', async () => {
  /** @type {string[]} */
  const methods = [];
  const loop = await startServer(async (req, res) => {
    methods.push(req.method ?? '');
    await readBody(req);
    res.writeHead(204);
    res.end();
  });

  const result = await postJson({ url: loop.url(), body: '{}' });
  assert.deepEqual(result, { ok: true, status: 204, body: '', attempts: 1 });
  assert.deepEqual(methods, ['POST']);
});

test('retries a 500 and succeeds with attempts === 2', async () => {
  let calls = 0;
  const loop = await startServer(async (req, res) => {
    calls += 1;
    await readBody(req);
    if (calls === 1) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
      return;
    }
    res.writeHead(200);
    res.end('recovered');
  });

  const result = await postJson({ url: loop.url(), body: '{}' }, { retryDelayMs: 0 });
  assert.deepEqual(result, { ok: true, status: 200, body: 'recovered', attempts: 2 });
  assert.equal(calls, 2);
});

test('honours retryDelayMs between attempts', async () => {
  let calls = 0;
  const loop = await startServer(async (req, res) => {
    calls += 1;
    await readBody(req);
    res.writeHead(calls === 1 ? 503 : 200);
    res.end(calls === 1 ? 'later' : 'ok');
  });

  const started = Date.now();
  const result = await postJson({ url: loop.url(), body: '{}' }, { retryDelayMs: 60 });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.ok(elapsed >= 50, `expected the retry delay to be awaited, elapsed=${elapsed}ms`);
});

test('does not retry a 404 (attempts === 1)', async () => {
  let calls = 0;
  const loop = await startServer(async (req, res) => {
    calls += 1;
    await readBody(req);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const result = await postJson({ url: loop.url(), body: '{}' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, 'HTTP 404');
  assert.equal(result.body, 'not found');
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});

test('does not retry a 302 and does not follow redirects', async () => {
  let calls = 0;
  const loop = await startServer(async (req, res) => {
    calls += 1;
    await readBody(req);
    res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
    res.end();
  });

  const result = await postJson({ url: loop.url(), body: '{}' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 302);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});

test('retries a 429 and gives up after the configured attempts', async () => {
  let calls = 0;
  const loop = await startServer(async (req, res) => {
    calls += 1;
    await readBody(req);
    res.writeHead(429, { 'retry-after': '0' });
    res.end('slow down');
  });

  const result = await postJson({ url: loop.url(), body: '{}' }, { retries: 2, retryDelayMs: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
});

test('retries transport errors (ECONNREFUSED) and resolves with status 0', async () => {
  const { server, port } = await startServer((req, res) => res.end('never reached'));
  await new Promise((resolve) => server.close(() => resolve()));

  const result = await postJson({ url: `http://127.0.0.1:${port}/hook`, body: '{}' }, { retries: 1, retryDelayMs: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.body, '');
  assert.equal(result.attempts, 2);
  assert.match(String(result.error), /ECONNREFUSED/);
});

test('enforces the timeout with req.setTimeout and never rejects', async () => {
  const loop = await startServer(async (req, res) => {
    await readBody(req);
    // Never answer.
    res.on('close', () => {});
  });

  const result = await postJson({ url: loop.url(), body: '{}' }, { timeoutMs: 120, retries: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.body, '');
  assert.equal(result.attempts, 1);
  assert.match(String(result.error), /timeout/i);
});

test('an aborted signal short-circuits to error "aborted"', async () => {
  let received = 0;
  const loop = await startServer(async (req, res) => {
    received += 1;
    await readBody(req);
    const timer = setTimeout(() => {
      try {
        res.writeHead(200);
        res.end('too late');
      } catch {
        /* the client is gone */
      }
    }, 1000);
    res.on('close', () => clearTimeout(timer));
  });

  const controller = new AbortController();
  const pending = postJson({ url: loop.url(), body: '{}' }, { signal: controller.signal, timeoutMs: 5000 });
  const aborter = setTimeout(() => controller.abort(), 60);
  const result = await pending;
  clearTimeout(aborter);

  assert.deepEqual(result, { ok: false, status: 0, body: '', error: 'aborted', attempts: 1 });
  assert.equal(received, 1);
});

test('a signal aborted before the call performs no attempt', async () => {
  let received = 0;
  const loop = await startServer((req, res) => {
    received += 1;
    res.end('nope');
  });

  const controller = new AbortController();
  controller.abort();
  const result = await postJson({ url: loop.url(), body: '{}' }, { signal: controller.signal, retries: 2 });

  assert.deepEqual(result, { ok: false, status: 0, body: '', error: 'aborted', attempts: 0 });
  assert.equal(received, 0);
});

test('never rejects on malformed requests', async () => {
  const cases = [
    { request: null, pattern: /url/ },
    { request: undefined, pattern: /url/ },
    { request: {}, pattern: /url/ },
    { request: { url: '' }, pattern: /url/ },
    { request: { url: '   ' }, pattern: /url/ },
    { request: { url: 'not a url' }, pattern: /url/ },
    { request: { url: 'ftp://example.com/hook' }, pattern: /unsupported protocol/ },
    { request: { url: 'file:///etc/passwd' }, pattern: /unsupported protocol/ },
  ];

  for (const { request, pattern } of cases) {
    const result = await postJson(request, { retries: 3, retryDelayMs: 0 });
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.status, 0, JSON.stringify(request));
    assert.equal(result.body, '');
    assert.equal(result.attempts, 0, 'no real HTTP attempt may be counted');
    assert.match(String(result.error), pattern);
  }
});

test('caps the response body at maxBodyBytes and reports ok', async () => {
  const payload = 'x'.repeat(5000);
  const loop = await startServer(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(payload);
  });

  const result = await postJson({ url: loop.url(), body: '{}' }, { maxBodyBytes: 128 });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.attempts, 1);
  assert.equal(result.body.length, 128);
  assert.equal(result.body, payload.slice(0, 128));
});

test('maxBodyBytes: 0 yields an empty body without hanging', async () => {
  const loop = await startServer(async (req, res) => {
    await readBody(req);
    res.writeHead(200);
    res.end('ignored');
  });

  const result = await postJson({ url: loop.url(), body: '{}' }, { maxBodyBytes: 0 });

  assert.equal(result.ok, true);
  assert.equal(result.body, '');
});

test('reports a locally rejected request instead of throwing or retrying', async () => {
  const result = await postJson({
    url: 'http://127.0.0.1:1/hook',
    headers: { 'x-bad': 'line\nbreak' },
    body: '{}',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.body, '');
  assert.equal(result.attempts, 1, 'a deterministic construction failure is not a transport error');
  assert.match(String(result.error), /ERR_INVALID_CHAR|Invalid character/);
});

test('both transport modules stay zero-dependency and shell-free', async () => {
  const { readFile } = await import('node:fs/promises');

  /** @type {Record<string, string>} */
  const sources = {};
  for (const file of ['../lib/http.js', '../lib/desktop.js']) {
    sources[file] = await readFile(new URL(file, import.meta.url), 'utf8');
  }

  for (const [file, source] of Object.entries(sources)) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/^\s*import[^;]*from\s+'(?!node:)/m.test(code), false, `${file} must import node:* only`);
    assert.equal(/\bimport\(\s*['"](?!node:)/.test(code), false, `${file} must import node:* only`);
    assert.equal(/\brequire\(/.test(code), false, `${file} must stay ESM`);
    assert.equal(/\bfetch\s*\(/.test(code), false, `${file} must not use fetch`);
    assert.equal(/from\s+'undici'/.test(code), false, `${file} must not use undici`);
    assert.equal(/shell\s*:\s*true/.test(code), false, `${file} must never use shell: true`);
  }

  assert.equal(/child_process/.test(sources['../lib/http.js']), false, 'http.js must not spawn');
  assert.equal(/node:http/.test(sources['../lib/desktop.js']), false, 'desktop.js must not do HTTP');
  assert.ok(sources['../lib/desktop.js'].includes("from 'node:child_process'"));
});
