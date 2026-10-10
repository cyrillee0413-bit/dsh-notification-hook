// Minimal Electron ASAR reader (zero deps). Usage:
//   node tools/asar.mjs ls <regex> [--limit N]
//   node tools/asar.mjs cat <exact-asar-path>
//   node tools/asar.mjs grep <regex> [--pathFilter <regex>] [--limit N]
import { openSync, readSync, readFileSync, closeSync, statSync } from 'node:fs';

const ASAR = process.env.ASAR_PATH ?? 'E:\\deepseek harness\\resources\\app.asar';

function readHeader() {
  const fd = openSync(ASAR, 'r');
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4); // pickle payload size holding the JSON
  const jsonSize = head.readUInt32LE(12); // string length inside that pickle
  const jsonBuf = Buffer.alloc(jsonSize);
  readSync(fd, jsonBuf, 0, jsonSize, 16);
  const dataOffset = 8 + headerSize;
  const json = JSON.parse(jsonBuf.toString('utf8'));
  return { fd, json, dataOffset };
}

function walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (value.files) walk(value, path, out);
    else out.push({ path, size: Number(value.size ?? 0), offset: Number(value.offset ?? 0) });
  }
}

function readEntry(fd, dataOffset, entry) {
  const buf = Buffer.alloc(entry.size);
  readSync(fd, buf, 0, entry.size, dataOffset + entry.offset);
  return buf;
}

const [cmd, arg] = process.argv.slice(2);
const flags = new Map();
for (let i = 4; i < process.argv.length; i += 2) flags.set(process.argv[i], process.argv[i + 1]);

const { fd, json, dataOffset } = readHeader();
const all = [];
walk(json, '', all);

if (cmd === 'ls' || cmd === 'list') {
  const re = new RegExp(arg, 'i');
  const limit = Number(flags.get('--limit') ?? 200);
  const hits = all.filter(e => re.test(e.path));
  for (const e of hits.slice(0, limit)) console.log(`${String(e.size).padStart(9)}  ${e.path}`);
  console.log(`# ${hits.length} match(es) of ${all.length} entries`);
} else if (cmd === 'cat') {
  const entry = all.find(e => e.path === arg);
  if (!entry) { console.error(`not found: ${arg}`); process.exit(2); }
  process.stdout.write(readEntry(fd, dataOffset, entry));
} else if (cmd === 'grep') {
  const re = new RegExp(arg);
  const pathFilter = flags.has('--pathFilter') ? new RegExp(flags.get('--pathFilter'), 'i') : null;
  const limit = Number(flags.get('--limit') ?? 40);
  let printed = 0;
  const candidates = all.filter(e => e.size < 4_000_000 && (!pathFilter || pathFilter.test(e.path)));
  for (const e of candidates) {
    if (printed >= limit) break;
    let text;
    try { text = readEntry(fd, dataOffset, e).toString('utf8'); } catch { continue; }
    const lines = text.split('\n');
    const hits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l));
    if (!hits.length) continue;
    console.log(`\n=== ${e.path} (${hits.length} hit(s)) ===`);
    for (const [n, l] of hits.slice(0, 12)) console.log(`${n}: ${l.length > 400 ? l.slice(0, 400) + '…' : l}`);
    printed++;
  }
  console.log(`\n# scanned ${candidates.length} entries`);
} else if (cmd === 'extract') {
  const re = new RegExp(arg, 'i');
  const dest = flags.get('--dest');
  if (!dest) { console.error('extract requires --dest <dir>'); process.exit(1); }
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const hits = all.filter(e => re.test(e.path));
  let n = 0;
  for (const e of hits) {
    const target = join(dest, e.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readEntry(fd, dataOffset, e));
    n++;
  }
  console.log(`# extracted ${n} file(s) under ${dest}`);
} else {
  console.error('usage: asar.mjs ls|cat|grep|extract ...');
  process.exit(1);
}
closeSync(fd);
