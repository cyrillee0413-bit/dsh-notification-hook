import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PACKAGE_NAME,
  assertManifestContract,
  redact,
  scanSecrets,
} from './contracts.mjs';
import { makeOwnedTemp, npmInvocation, removeOwnedTemp, run, sha256 } from './support.mjs';

export const EXPECTED_PACKAGE_FILES = Object.freeze([
  'LICENSE',
  'README.md',
  'README.zh.md',
  'cordis.patch.yml',
  'docs/WEBHOOK-GUIDE.md',
  'docs/WEBHOOK-GUIDE.zh.md',
  'icon.svg',
  'lib/classify.js',
  'lib/client.js',
  'lib/config.js',
  'lib/desktop.js',
  'lib/dispatch.js',
  'lib/format.js',
  'lib/http.js',
  'lib/payloads.js',
  'locale/en.json',
  'locale/zh.json',
  'package.json',
  'plugin.js',
]);

const TEXT_FILE = /(?:^LICENSE$|\.(?:js|json|md|svg|ya?ml))$/iu;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeArchivePath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function sameFiles(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeIfPresent(path) {
  if (await exists(path)) await rm(path, { force: false });
}

async function promoteVerifiedPair({ archivePath, checksumPath, destination, filename }) {
  await mkdir(destination, { recursive: true });
  const suffix = randomUUID();
  const finalArchive = join(destination, filename);
  const finalChecksum = `${finalArchive}.sha256`;
  const pendingArchive = join(destination, `.${filename}.${suffix}.pending`);
  const pendingChecksum = `${pendingArchive}.sha256`;
  const backupArchive = join(destination, `.${filename}.${suffix}.backup`);
  const backupChecksum = `${backupArchive}.sha256`;
  let archiveBackedUp = false;
  let checksumBackedUp = false;
  let archivePromoted = false;
  let checksumPromoted = false;

  try {
    await copyFile(archivePath, pendingArchive);
    await copyFile(checksumPath, pendingChecksum);
    if (await exists(finalArchive)) {
      await rename(finalArchive, backupArchive);
      archiveBackedUp = true;
    }
    if (await exists(finalChecksum)) {
      await rename(finalChecksum, backupChecksum);
      checksumBackedUp = true;
    }
    await rename(pendingArchive, finalArchive);
    archivePromoted = true;
    await rename(pendingChecksum, finalChecksum);
    checksumPromoted = true;
  } catch (error) {
    if (checksumPromoted) await removeIfPresent(finalChecksum);
    if (archivePromoted) await removeIfPresent(finalArchive);
    if (checksumBackedUp) await rename(backupChecksum, finalChecksum);
    if (archiveBackedUp) await rename(backupArchive, finalArchive);
    await removeIfPresent(pendingChecksum);
    await removeIfPresent(pendingArchive);
    throw error;
  }

  await removeIfPresent(backupChecksum);
  await removeIfPresent(backupArchive);
  return { archivePath: finalArchive, checksumPath: finalChecksum };
}

export function parsePackOutput(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('npm pack JSON output is malformed');
  }
  invariant(Array.isArray(parsed) && parsed.length === 1, 'npm pack JSON must contain exactly one record');
  const record = parsed[0];
  invariant(record && typeof record === 'object' && !Array.isArray(record), 'npm pack record is invalid');
  invariant(typeof record.name === 'string' && record.name.length > 0, 'npm pack record is missing name');
  invariant(typeof record.version === 'string' && record.version.length > 0, 'npm pack record is missing version');
  invariant(typeof record.filename === 'string' && record.filename.length > 0, 'npm pack record is missing filename');
  invariant(Number.isInteger(record.size) && record.size >= 0, 'npm pack record is missing a valid size');
  invariant(Array.isArray(record.files), 'npm pack record is missing files');
  return record;
}

export function assertArchiveFiles(files) {
  invariant(Array.isArray(files), 'archive file list is invalid');
  const normalized = files.map((entry) => normalizeArchivePath(entry?.path)).sort();
  const expected = [...EXPECTED_PACKAGE_FILES].sort();
  const missing = expected.filter((path) => !normalized.includes(path));
  const unexpected = normalized.filter((path) => !expected.includes(path));
  invariant(missing.length === 0, `archive is missing required files: ${missing.join(', ')}`);
  invariant(unexpected.length === 0, `archive contains unexpected files: ${unexpected.join(', ')}`);
  invariant(new Set(normalized).size === normalized.length, 'archive contains duplicate file paths');
  return normalized;
}

export function assertSafePatch(text) {
  invariant(typeof text === 'string', 'published cordis.patch.yml must be text');
  invariant(/^\s*webhooks:\s*\[\s*\]\s*(?:#.*)?$/mu.test(text), 'published patch must keep webhooks: []');
  invariant(/^\s*testOnActivate:\s*false\s*(?:#.*)?$/mu.test(text), 'published patch must keep testOnActivate: false');
  invariant(!/api\.telegram\.org\/bot/iu.test(text), 'published patch must not contain a Telegram bot endpoint');
  const findings = scanSecrets('cordis.patch.yml', text);
  invariant(findings.length === 0, `published patch contains a secret (${findings.map(({ type }) => type).join(', ')})`);
  return text;
}

async function listFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(root, fullPath));
    else if (entry.isFile()) output.push(relative(root, fullPath).split(sep).join('/'));
    else throw new Error(`installed package contains a non-file entry: ${entry.name}`);
  }
  return output.sort();
}

async function validateInstalledPackage(packageRoot, record) {
  const installedFiles = await listFiles(packageRoot);
  const expected = [...EXPECTED_PACKAGE_FILES].sort();
  invariant(sameFiles(installedFiles, expected), `installed package file set differs from archive: ${installedFiles.join(', ')}`);

  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assertManifestContract(manifest);
  invariant(manifest.name === record.name && manifest.version === record.version, 'installed manifest differs from npm pack metadata');

  const patch = await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8');
  assertSafePatch(patch);

  const findings = [];
  for (const file of installedFiles.filter((path) => TEXT_FILE.test(path))) {
    findings.push(...scanSecrets(file, await readFile(join(packageRoot, file), 'utf8')));
  }
  invariant(
    findings.length === 0,
    `published package contains credential-shaped or local-path content: ${findings.map(({ file, type }) => `${file}:${type}`).join(', ')}`,
  );

  const entryUrl = `${pathToFileURL(join(packageRoot, 'plugin.js')).href}?verify=${Date.now()}-${Math.random()}`;
  const plugin = await import(entryUrl);
  invariant(plugin.name === 'notifyHook', 'installed package is missing the notifyHook identity');
  invariant(typeof plugin.apply === 'function', 'installed package is missing the Host apply export');
  invariant(typeof plugin.createDeliver === 'function', 'installed package is missing the Host delivery export');
  invariant(plugin.Config?.[Symbol.for('schemastery')] === true, 'installed package did not resolve native Schemastery');
  invariant(plugin.Config?.meta?.volatile === true, 'installed Config is not volatile');
}

export async function verifyPackage({
  projectRoot,
  outputDir,
  runCommand = run,
  npmCommand,
} = {}) {
  const root = resolve(projectRoot ?? process.cwd());
  const destination = resolve(outputDir ?? join(root, 'dist'));
  let installRoot;
  let stageRoot;
  try {
    const npm = npmCommand
      ? { command: npmCommand, args: [] }
      : await npmInvocation();
    const sourceManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assertManifestContract(sourceManifest);
    stageRoot = await makeOwnedTemp('package-stage');
    const packed = await runCommand(
      npm.command,
      [...npm.args, 'pack', '--json', '--pack-destination', stageRoot],
      { cwd: root },
    );
    const record = parsePackOutput(packed.stdout);
    invariant(record.name === PACKAGE_NAME, `npm pack returned unexpected package name: ${record.name}`);
    invariant(
      record.version === sourceManifest.version,
      `npm pack returned package version ${record.version}, expected ${sourceManifest.version}`,
    );
    invariant(basename(record.filename) === record.filename, 'npm pack returned an unsafe archive filename');
    const files = assertArchiveFiles(record.files);
    const archivePath = resolve(stageRoot, record.filename);
    invariant(relative(stageRoot, archivePath) === record.filename, 'npm pack archive escaped the staging directory');
    try {
      await access(archivePath);
    } catch {
      throw new Error(`npm pack archive is missing: ${record.filename}`);
    }
    const archiveStat = await stat(archivePath);
    invariant(archiveStat.isFile(), 'npm pack archive is not a regular file');
    invariant(archiveStat.size === record.size, 'npm pack archive size differs from its JSON record');

    installRoot = await makeOwnedTemp('package-install');
    await writeFile(join(installRoot, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8');
    await runCommand(
      npm.command,
      [...npm.args, 'install', '--ignore-scripts', '--no-audit', '--no-fund', archivePath],
      { cwd: installRoot },
    );
    const packageRoot = join(installRoot, 'node_modules', PACKAGE_NAME);
    await validateInstalledPackage(packageRoot, record);

    const digest = await sha256(archivePath);
    const checksumPath = `${archivePath}.sha256`;
    await writeFile(checksumPath, `${digest}  ${record.filename}\n`, 'utf8');
    const promoted = await promoteVerifiedPair({
      archivePath,
      checksumPath,
      destination,
      filename: record.filename,
    });
    return {
      archivePath: promoted.archivePath,
      checksumPath: promoted.checksumPath,
      sha256: digest,
      files,
      size: archiveStat.size,
      name: record.name,
      version: record.version,
    };
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : String(error)));
  } finally {
    const cleanups = [];
    if (installRoot) cleanups.push(removeOwnedTemp(installRoot));
    if (stageRoot) cleanups.push(removeOwnedTemp(stageRoot));
    await Promise.all(cleanups);
  }
}

function readCliOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  invariant(process.argv[index + 1], `${name} requires a value`);
  return process.argv[index + 1];
}

async function main() {
  const summary = await verifyPackage({
    projectRoot: process.cwd(),
    outputDir: readCliOption('--out-dir', join(process.cwd(), 'dist')),
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
