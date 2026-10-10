import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redact } from './contracts.mjs';
import { npmInvocation, run } from './support.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function registryMissing(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\bE404\b|\b404\b[^\n]*(?:not found|not in this registry)/iu.test(message);
}

async function assertUnpublished({ name, version, root, runCommand }) {
  const npm = await npmInvocation();
  let result;
  try {
    result = await runCommand(
      npm.command,
      [...npm.args, 'view', `${name}@${version}`, 'version', '--json'],
      { cwd: root },
    );
  } catch (error) {
    if (registryMissing(error)) return;
    throw error;
  }
  const output = result.stdout.trim();
  invariant(output.length > 0, 'npm registry returned an empty response');
  let publishedVersion = output;
  try {
    publishedVersion = JSON.parse(output);
  } catch {
    // npm may print the scalar without JSON quoting on older compatible clients.
  }
  invariant(publishedVersion !== version, `${name}@${version} is already published`);
  throw new Error(`npm registry returned an unexpected version response: ${String(publishedVersion)}`);
}

export async function preflight({
  projectRoot = process.cwd(),
  mode = 'dry-run',
  tag,
  runCommand = run,
} = {}) {
  const root = resolve(projectRoot);
  try {
    invariant(mode === 'dry-run' || mode === 'publish', 'mode must be dry-run or publish');
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    invariant(typeof manifest.name === 'string' && manifest.name.length > 0, 'package name is missing');
    invariant(typeof manifest.version === 'string' && manifest.version.length > 0, 'package version is missing');
    const expectedTag = `v${manifest.version}`;
    if (mode === 'publish') invariant(tag === expectedTag, `release tag must be exactly ${expectedTag}`);

    const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
    const escapedVersion = manifest.version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    invariant(
      new RegExp(`^## \\[${escapedVersion}\\](?:\\s|$)`, 'mu').test(changelog),
      `CHANGELOG.md is missing version ${manifest.version}`,
    );

    if (mode === 'publish') {
      const status = await runCommand('git', ['status', '--porcelain'], { cwd: root });
      invariant(status.stdout.trim() === '', 'Git working tree must be clean before publishing');
    }

    await assertUnpublished({
      name: manifest.name,
      version: manifest.version,
      root,
      runCommand,
    });
    return {
      mode,
      name: manifest.name,
      version: manifest.version,
      tag: tag ?? null,
      unpublished: true,
    };
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : String(error)));
  }
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function main() {
  const summary = await preflight({
    mode: option('--mode', 'dry-run'),
    tag: option('--tag', undefined),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
