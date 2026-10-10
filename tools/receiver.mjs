#!/usr/bin/env node
/**
 * Loopback receiver for the live install check.
 *
 * Accepts any POST, appends one JSON line per request to `OUT`, and echoes a JSON ack.
 * Used to prove that the installed plugin really posts when a session ends.
 *
 *   node tools/receiver.mjs                     # 127.0.0.1:8791 -> receiver.jsonl
 *   PORT=9000 OUT=C:\tmp\hits.jsonl node tools/receiver.mjs
 */
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const port = Number(process.env.PORT ?? 8791);
const out = process.env.OUT ?? 'receiver.jsonl';

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { unparsed: raw.slice(0, 2000) };
    }
    const record = {
      at: new Date().toISOString(),
      method: request.method,
      url: request.url,
      contentType: request.headers['content-type'] ?? null,
      length: raw.length,
      body,
    };
    appendFileSync(out, `${JSON.stringify(record)}\n`, 'utf8');
    console.log(`[receiver] ${record.at} ${request.method} ${request.url} ${raw.length}B -> ${out}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[receiver] listening on http://127.0.0.1:${port}/notify -> ${out}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[receiver] ${signal}, closing`);
    server.close(() => process.exit(0));
  });
}
