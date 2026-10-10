import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redact } from './contracts.mjs';
import { run } from './support.mjs';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs']);

function extension(path) {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index);
}

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extension(entry.name))) files.push(path);
  }
  return files;
}

export async function checkSyntax(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const files = [join(root, 'plugin.js')];
  for (const directory of ['lib', 'test', 'tools']) files.push(...await collect(join(root, directory)));
  files.sort();
  for (const file of files) await run(process.execPath, ['--check', file], { cwd: root });
  return {
    files: files.map((file) => relative(root, file).split(sep).join('/')),
  };
}

async function main() {
  process.stdout.write(`${JSON.stringify(await checkSyntax())}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
