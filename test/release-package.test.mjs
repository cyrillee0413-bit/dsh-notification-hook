import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EXPECTED_PACKAGE_FILES,
  assertArchiveFiles,
  assertSafePatch,
  parsePackOutput,
  verifyPackage,
} from '../tools/release/verify-package.mjs';
import { makeOwnedTemp, npmInvocation, removeOwnedTemp, run } from '../tools/release/support.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function copyPublishSource(destination) {
  await mkdir(destination, { recursive: true });
  for (const relativePath of EXPECTED_PACKAGE_FILES) {
    if (relativePath === 'package.json') continue;
    const source = join(PROJECT_ROOT, relativePath);
    const target = join(destination, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
  await cp(join(PROJECT_ROOT, 'package.json'), join(destination, 'package.json'));
}

async function importInstalledPackage(consumer) {
  const entry = join(consumer, 'node_modules', 'dsh-notification-hook', 'plugin.js');
  return import(`${pathToFileURL(entry).href}?test=${Date.now()}-${Math.random()}`);
}

test('npm pack JSON is strict and rejects empty, malformed or incomplete output', () => {
  const record = {
    name: 'dsh-notification-hook',
    version: '0.3.0',
    filename: 'dsh-notification-hook-0.3.0.tgz',
    size: 123,
    files: EXPECTED_PACKAGE_FILES.map((path) => ({ path, size: 1 })),
  };
  assert.deepEqual(parsePackOutput(JSON.stringify([record])), record);
  for (const output of [
    '',
    'not json',
    '[]',
    '[{}]',
    '{}',
    JSON.stringify([record, record]),
    JSON.stringify({ first: record, second: record }),
  ]) {
    assert.throws(() => parsePackOutput(output), /npm pack|JSON|record|filename/i, output);
  }
});

test('npm pack JSON accepts the keyed record emitted by npm 12', () => {
  const record = {
    id: 'dsh-notification-hook@0.3.0',
    name: 'dsh-notification-hook',
    version: '0.3.0',
    filename: 'dsh-notification-hook-0.3.0.tgz',
    size: 123,
    files: EXPECTED_PACKAGE_FILES.map((path) => ({ path, size: 1 })),
  };
  const output = JSON.stringify({ 'dsh-notification-hook': record });

  assert.deepEqual(parsePackOutput(output), record);
});

test('archive file validation is exact and normalizes Windows separators', () => {
  const windowsPaths = EXPECTED_PACKAGE_FILES.map((path) => ({ path: path.replaceAll('/', '\\') }));
  assert.deepEqual(assertArchiveFiles(windowsPaths), EXPECTED_PACKAGE_FILES);
  assert.throws(
    () => assertArchiveFiles(windowsPaths.filter(({ path }) => path !== 'LICENSE')),
    /LICENSE.*missing|missing.*LICENSE/i,
  );
  assert.throws(
    () => assertArchiveFiles([...windowsPaths, { path: 'test\\secret.test.mjs' }]),
    /unexpected|test\/secret/i,
  );
});

test('published patch defaults are inert and credential-shaped content is rejected', () => {
  const safe = '- insert:\n    - id: notify-hook\n      config:\n        webhooks: []\n        testOnActivate: false\n';
  const telegramCredential = ['123456789', ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdef'].join('')].join(':');
  assert.doesNotThrow(() => assertSafePatch(safe));
  assert.throws(() => assertSafePatch(safe.replace('webhooks: []', 'webhooks:\n  - url: https://example.test')), /webhooks/i);
  assert.throws(() => assertSafePatch(safe.replace('false', 'true')), /testOnActivate/i);
  assert.throws(
    () => assertSafePatch(`${safe}\nhttps://api.telegram.org/bot${telegramCredential}/sendMessage`),
    /secret|telegram/i,
  );
});

test('release scripts expose a portable syntax and package verification surface', async () => {
  const manifest = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['check:syntax'], 'node tools/release/check-syntax.mjs');
  assert.equal(manifest.scripts.check, 'npm run check:syntax && npm test');
  assert.equal(manifest.scripts['verify:package'], 'node tools/release/verify-package.mjs');

  const result = await run(process.execPath, [join(PROJECT_ROOT, 'tools/release/check-syntax.mjs')], { cwd: PROJECT_ROOT });
  const summary = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
  assert.ok(summary.files.includes('plugin.js'));
  assert.ok(summary.files.includes('test/release-package.test.mjs'));
  assert.ok(summary.files.includes('tools/release/verify-package.mjs'));
});

test('verifier rejects malformed pack output, a missing archive and redacts child errors', async () => {
  const output = await makeOwnedTemp('package-errors');
  const secret = ['Bearer', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(' ');
  const manifest = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  try {
    await assert.rejects(
      verifyPackage({ projectRoot: PROJECT_ROOT, outputDir: output, runCommand: async () => ({ stdout: 'oops', stderr: '', code: 0 }) }),
      /npm pack JSON/i,
    );
    await assert.rejects(
      verifyPackage({
        projectRoot: PROJECT_ROOT,
        outputDir: output,
        runCommand: async () => ({
          stdout: JSON.stringify([{
            name: 'dsh-notification-hook',
            version: manifest.version,
            filename: 'missing.tgz',
            size: 10,
            files: EXPECTED_PACKAGE_FILES.map((path) => ({ path, size: 1 })),
          }]),
          stderr: '',
          code: 0,
        }),
      }),
      /archive.*missing|missing.*archive/i,
    );
    await assert.rejects(
      verifyPackage({ projectRoot: PROJECT_ROOT, outputDir: output, runCommand: async () => { throw new Error(secret); } }),
      (error) => {
        assert.equal(error.message.includes(secret), false);
        assert.match(error.message, /<redacted>/);
        return true;
      },
    );
  } finally {
    await removeOwnedTemp(output);
  }
});

test('a real candidate installs cleanly with a native volatile schema', async () => {
  const output = await makeOwnedTemp('package-valid');
  const manifest = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  try {
    const summary = await verifyPackage({ projectRoot: PROJECT_ROOT, outputDir: output });
    assert.equal(summary.name, 'dsh-notification-hook');
    assert.equal(summary.version, manifest.version);
    assert.deepEqual(summary.files, EXPECTED_PACKAGE_FILES);
    assert.match(summary.sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      await readFile(summary.checksumPath, 'utf8'),
      `${summary.sha256}  dsh-notification-hook-${manifest.version}.tgz\n`,
    );
  } finally {
    await removeOwnedTemp(output);
  }
});

test('package verification derives a prerelease version from the source manifest', async () => {
  const workspace = await makeOwnedTemp('package-prerelease');
  const source = join(workspace, 'source');
  const output = join(workspace, 'dist');
  try {
    await copyPublishSource(source);
    const manifestPath = join(source, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: '0.3.0-rc.0' }, null, 2)}\n`);

    const summary = await verifyPackage({ projectRoot: source, outputDir: output });
    assert.equal(summary.version, '0.3.0-rc.0');
    assert.match(summary.archivePath, /dsh-notification-hook-0\.3\.0-rc\.0\.tgz$/u);
  } finally {
    await removeOwnedTemp(workspace);
  }
});

test('bare link falls back while the candidate tarball resolves native Schemastery', async () => {
  const workspace = await makeOwnedTemp('link-vs-tarball');
  const source = join(workspace, 'source');
  const output = join(workspace, 'dist with spaces');
  const linkedConsumer = join(workspace, 'linked consumer');
  const packedConsumer = join(workspace, 'packed consumer');
  try {
    const npm = await npmInvocation();
    await copyPublishSource(source);
    await mkdir(output, { recursive: true });
    await mkdir(linkedConsumer, { recursive: true });
    await mkdir(packedConsumer, { recursive: true });
    await writeFile(join(linkedConsumer, 'package.json'), '{"private":true,"type":"module"}\n');
    await writeFile(join(packedConsumer, 'package.json'), '{"private":true,"type":"module"}\n');

    await run(npm.command, [...npm.args, 'install', '--ignore-scripts', '--no-audit', '--no-fund', `file:${source}`], { cwd: linkedConsumer });
    const linked = await importInstalledPackage(linkedConsumer);
    assert.notEqual(linked.Config?.[Symbol.for('schemastery')], true);

    const summary = await verifyPackage({ projectRoot: PROJECT_ROOT, outputDir: output });
    await run(npm.command, [...npm.args, 'install', '--ignore-scripts', '--no-audit', '--no-fund', summary.archivePath], { cwd: packedConsumer });
    const packed = await importInstalledPackage(packedConsumer);
    assert.equal(packed.Config?.[Symbol.for('schemastery')], true);
    assert.equal(packed.Config?.meta?.volatile, true);
  } finally {
    await removeOwnedTemp(workspace);
  }
});

test('verification failure leaves no owned install directory behind', async () => {
  const fixture = await makeOwnedTemp('unsafe-project');
  const project = join(fixture, 'project');
  const output = join(fixture, 'dist');
  const prefix = 'dsh-notification-hook-package-install-';
  const stagePrefix = 'dsh-notification-hook-package-stage-';
  try {
    await copyPublishSource(project);
    await mkdir(output, { recursive: true });
    const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
    const patchPath = join(project, 'cordis.patch.yml');
    const patch = await readFile(patchPath, 'utf8');
    await writeFile(patchPath, patch.replace('testOnActivate: false', 'testOnActivate: true'));
    await mkdir(output, { recursive: true });
    const finalArchive = join(output, `dsh-notification-hook-${manifest.version}.tgz`);
    const finalChecksum = `${finalArchive}.sha256`;
    await writeFile(finalArchive, 'previous verified archive');
    await writeFile(finalChecksum, 'previous verified checksum');
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith(prefix)).sort();
    const stageBefore = (await readdir(tmpdir())).filter((name) => name.startsWith(stagePrefix)).sort();
    await assert.rejects(verifyPackage({ projectRoot: project, outputDir: output }), /testOnActivate/i);
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith(prefix)).sort();
    const stageAfter = (await readdir(tmpdir())).filter((name) => name.startsWith(stagePrefix)).sort();
    assert.deepEqual(after, before);
    assert.deepEqual(stageAfter, stageBefore);
    assert.equal(await readFile(finalArchive, 'utf8'), 'previous verified archive');
    assert.equal(await readFile(finalChecksum, 'utf8'), 'previous verified checksum');
  } finally {
    await removeOwnedTemp(fixture);
  }
});
