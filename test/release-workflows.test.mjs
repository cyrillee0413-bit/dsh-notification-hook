import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { preflight } from '../tools/release/preflight.mjs';
import { makeOwnedTemp, removeOwnedTemp } from '../tools/release/support.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function makeProject({ changelog = true, version = '0.3.0' } = {}) {
  const root = await makeOwnedTemp('preflight-project');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-notification-hook', version }));
  await writeFile(join(root, 'CHANGELOG.md'), changelog ? `# Changelog\n\n## [${version}] - 2026-10-10\n` : '# Changelog\n');
  return root;
}

function commandStub({ npm = '404', git = '' } = {}) {
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    if (args.includes('status')) return { stdout: git, stderr: '', code: 0 };
    if (args.includes('view')) {
      if (npm === '404') throw new Error('npm error code E404\nnpm error 404 Not Found');
      if (npm === 'network') throw new Error('npm error code ECONNRESET\nnetwork connection lost');
      return { stdout: JSON.stringify(npm), stderr: '', code: 0 };
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  return { calls, runCommand };
}

test('dry-run accepts registry 404 without requiring a tag or clean tree', async () => {
  const root = await makeProject();
  const stub = commandStub({ git: ' M package.json' });
  try {
    const result = await preflight({ projectRoot: root, mode: 'dry-run', runCommand: stub.runCommand });
    assert.deepEqual(result, {
      mode: 'dry-run',
      name: 'dsh-notification-hook',
      version: '0.3.0',
      tag: null,
      unpublished: true,
    });
    assert.equal(stub.calls.some(({ args }) => args.includes('status')), false);
    assert.equal(stub.calls.some(({ args }) => args.includes('publish')), false);
  } finally {
    await removeOwnedTemp(root);
  }
});

test('publish mode requires the exact tag, changelog entry and clean Git tree', async () => {
  const root = await makeProject();
  try {
    await assert.rejects(preflight({
      projectRoot: root,
      mode: 'publish',
      tag: 'v0.3.1',
      runCommand: commandStub().runCommand,
    }), /tag.*v0\.3\.0/i);

    const dirty = commandStub({ git: ' M package.json' });
    await assert.rejects(preflight({
      projectRoot: root,
      mode: 'publish',
      tag: 'v0.3.0',
      runCommand: dirty.runCommand,
    }), /Git.*clean|dirty|working tree/i);

    await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n');
    await assert.rejects(preflight({
      projectRoot: root,
      mode: 'publish',
      tag: 'v0.3.0',
      runCommand: commandStub().runCommand,
    }), /changelog.*0\.3\.0/i);
  } finally {
    await removeOwnedTemp(root);
  }
});

test('registry states distinguish unpublished, already published and network failure', async () => {
  const root = await makeProject();
  try {
    await assert.doesNotReject(preflight({ projectRoot: root, mode: 'dry-run', runCommand: commandStub().runCommand }));
    await assert.rejects(
      preflight({ projectRoot: root, mode: 'dry-run', runCommand: commandStub({ npm: '0.3.0' }).runCommand }),
      /already published/i,
    );
    await assert.rejects(
      preflight({ projectRoot: root, mode: 'dry-run', runCommand: commandStub({ npm: 'network' }).runCommand }),
      /ECONNRESET|network/i,
    );
  } finally {
    await removeOwnedTemp(root);
  }
});

test('dry-run preflight accepts a prerelease with its own changelog entry', async () => {
  const root = await makeProject({ version: '0.3.0-rc.0' });
  try {
    const result = await preflight({ projectRoot: root, mode: 'dry-run', runCommand: commandStub().runCommand });
    assert.equal(result.version, '0.3.0-rc.0');
    assert.equal(result.unpublished, true);
  } finally {
    await removeOwnedTemp(root);
  }
});

test('CI is reusable, three-platform, Node 22 and Ubuntu-only for lifecycle artifacts', async () => {
  const yaml = await readFile(join(PROJECT_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(yaml, /workflow_call:/);
  assert.match(yaml, /pull_request:/);
  assert.match(yaml, /push:/);
  assert.match(yaml, /permissions:\s*\n\s*contents:\s*read/);
  for (const os of ['windows-latest', 'macos-latest', 'ubuntu-latest']) assert.match(yaml, new RegExp(os));
  assert.match(yaml, /actions\/checkout@v7/);
  assert.match(yaml, /actions\/setup-node@v7/);
  assert.match(yaml, /node-version:\s*['"]?22['"]?/);
  assert.match(yaml, /npm ci/);
  assert.match(yaml, /npm run check/);
  assert.match(yaml, /npm run verify:package -- --out-dir dist/);
  assert.match(yaml, /if:\s*matrix\.os == 'ubuntu-latest'[\s\S]*npm run verify:dsh -- --archive-dir dist/);
  assert.doesNotMatch(yaml, /dsh-notification-hook-0\.3\.0\.tgz/);
  assert.match(yaml, /actions\/upload-artifact@v4/);
  assert.match(yaml, /\.tgz\.sha256/);
  assert.doesNotMatch(yaml, /contents:\s*write|id-token:\s*write/);
});

test('release dry-run cannot publish and tag publishing uses exact modern OIDC tooling', async () => {
  const yaml = await readFile(join(PROJECT_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /tags:\s*\n\s*- ['"]v\*['"]/);
  assert.match(yaml, /uses:\s*\.\/\.github\/workflows\/ci\.yml/);
  assert.match(yaml, /if:\s*github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  const rehearsal = yaml.match(/\n  rehearse:[\s\S]*?\n  publish:/u)?.[0];
  assert.ok(rehearsal, 'manual release rehearsal job is missing');
  assert.match(rehearsal, /if:\s*github\.event_name == 'workflow_dispatch'/);
  assert.match(rehearsal, /node-version:\s*['"]24\.15\.0['"]/);
  assert.match(rehearsal, /package-manager-cache:\s*false/);
  assert.match(rehearsal, /npm install[^\n]*--prefix "\$RUNNER_TEMP\/npm-cli"[^\n]*npm@12\.2\.0/);
  assert.match(rehearsal, /echo "\$RUNNER_TEMP\/npm-cli\/node_modules\/\.bin" >> "\$GITHUB_PATH"/);
  assert.match(rehearsal, /npm run verify:package -- --out-dir dist/);
  assert.match(rehearsal, /npm run release:preflight -- --mode dry-run/);
  assert.doesNotMatch(rehearsal, /npm publish|gh release|contents:\s*write|id-token:\s*write/);
  assert.match(yaml, /permissions:[\s\S]*contents:\s*write[\s\S]*id-token:\s*write/);
  assert.match(yaml, /actions\/checkout@v7/);
  assert.match(yaml, /actions\/setup-node@v7/);
  assert.match(yaml, /node-version:\s*['"]24\.15\.0['"]/);
  assert.match(yaml, /package-manager-cache:\s*false/);
  assert.doesNotMatch(yaml, /npm install --global|sudo npm/);
  assert.match(yaml, /npm install[^\n]*--prefix "\$RUNNER_TEMP\/npm-cli"[^\n]*npm@12\.2\.0/);
  assert.match(yaml, /echo "\$RUNNER_TEMP\/npm-cli\/node_modules\/\.bin" >> "\$GITHUB_PATH"/);
  assert.match(yaml, /npm run release:preflight -- --mode publish --tag "\$GITHUB_REF_NAME"/);
  assert.doesNotMatch(yaml, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(yaml, /--provenance/);
  assert.match(yaml, /gh release view "\$GITHUB_REF_NAME" --json isDraft/);
  assert.match(yaml, /gh release upload "\$GITHUB_REF_NAME"[\s\S]*--clobber/);
  const draft = yaml.indexOf('gh release create');
  const publish = yaml.indexOf('npm publish');
  const expose = yaml.indexOf('gh release edit');
  assert.ok(draft !== -1 && publish > draft && expose > publish, 'draft → npm publish → public release ordering');
});

test('package.json exposes release preflight', async () => {
  const manifest = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['release:preflight'], 'node tools/release/preflight.mjs');
});
