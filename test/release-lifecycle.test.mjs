import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertInstalledState,
  assertRemovedState,
  resolveCandidateArchive,
  inspectProfileState,
  resolveProfileDir,
} from '../tools/release/verify-dsh-lifecycle.mjs';
import { makeOwnedTemp, removeOwnedTemp } from '../tools/release/support.mjs';

async function createProfileFixture({
  dependency = 'file:/tmp/dsh-notification-hook-0.3.0.tgz',
  bundle = true,
  installedVersion = '0.3.0',
} = {}) {
  const dshHome = await makeOwnedTemp('lifecycle-state');
  const profile = 'ci-profile';
  const profileDir = join(dshHome, 'profiles', profile);
  await mkdir(profileDir, { recursive: true });
  const manifest = {
    name: 'dsh-profile-ci',
    private: true,
    dependencies: dependency ? { 'dsh-notification-hook': dependency } : {},
    dsh: { profile: { bundles: bundle ? ['@deepseek-ai/dsh-base', 'dsh-notification-hook'] : ['@deepseek-ai/dsh-base'] } },
  };
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (installedVersion) {
    const installed = join(profileDir, 'node_modules', 'dsh-notification-hook');
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, 'package.json'), `${JSON.stringify({ name: 'dsh-notification-hook', version: installedVersion })}\n`);
  }
  return { dshHome, profile, profileDir };
}

const installedDump = [
  '# == dsh-notification-hook',
  '- id: notify-hook',
  '  name: dsh-notification-hook',
  '  config:',
  '    enabled: true',
].join('\n');

test('installed state requires the exact dependency, version, bundle and notify-hook row', async () => {
  const fixture = await createProfileFixture();
  try {
    const state = await inspectProfileState({ ...fixture, dumpConfig: installedDump });
    assert.doesNotThrow(() => assertInstalledState(state, {
      version: '0.3.0',
      specifier: 'file:/tmp/dsh-notification-hook-0.3.0.tgz',
    }));
    assert.equal(state.installed, true);
    assert.equal(state.bundle, true);
    assert.equal(state.notifyHook, true);
  } finally {
    await removeOwnedTemp(fixture.dshHome);
  }
});

test('installed state rejects each stale or incomplete dimension', async () => {
  const base = {
    dependency: 'file:/tmp/candidate.tgz',
    bundle: true,
    installed: true,
    installedVersion: '0.3.0',
    notifyHook: true,
  };
  const expected = { version: '0.3.0', specifier: 'file:/tmp/candidate.tgz' };
  for (const [field, value] of [
    ['dependency', 'file:/tmp/old.tgz'],
    ['bundle', false],
    ['installed', false],
    ['installedVersion', '0.3.0-ci-old.0'],
    ['notifyHook', false],
  ]) {
    assert.throws(() => assertInstalledState({ ...base, [field]: value }, expected), new RegExp(field, 'i'));
  }
});

test('removed state rejects dependency, installed directory, bundle or row residue', () => {
  const removed = {
    dependency: undefined,
    bundle: false,
    installed: false,
    installedVersion: undefined,
    notifyHook: false,
  };
  assert.doesNotThrow(() => assertRemovedState(removed));
  for (const [field, value] of [
    ['dependency', 'file:/tmp/candidate.tgz'],
    ['bundle', true],
    ['installed', true],
    ['notifyHook', true],
  ]) {
    assert.throws(() => assertRemovedState({ ...removed, [field]: value }), new RegExp(field, 'i'));
  }
});

test('profile resolution cannot escape the isolated DSH home', async () => {
  const dshHome = await makeOwnedTemp('lifecycle-path');
  try {
    assert.equal(resolveProfileDir(dshHome, 'release-ci'), join(dshHome, 'profiles', 'release-ci'));
    for (const profile of ['../desktop', '..\\desktop', '/desktop', 'C:\\desktop', '.', '']) {
      assert.throws(() => resolveProfileDir(dshHome, profile), /profile|escape|invalid/i, profile);
    }
  } finally {
    await removeOwnedTemp(dshHome);
  }
});

test('candidate archive discovery accepts exactly one tarball without a hardcoded version', async () => {
  const directory = await makeOwnedTemp('lifecycle-archive');
  try {
    const prerelease = join(directory, 'dsh-notification-hook-0.3.0-rc.0.tgz');
    await writeFile(prerelease, 'fixture');
    await writeFile(join(directory, 'dsh-notification-hook-0.3.0-rc.0.tgz.sha256'), 'fixture');
    assert.equal(await resolveCandidateArchive({ archiveDir: directory }), prerelease);

    const second = join(directory, 'dsh-notification-hook-0.3.0.tgz');
    await writeFile(second, 'fixture');
    await assert.rejects(resolveCandidateArchive({ archiveDir: directory }), /exactly one.*\.tgz/i);
    await assert.rejects(
      resolveCandidateArchive({ archivePath: prerelease, archiveDir: directory }),
      /either.*archive.*archive-dir/i,
    );
  } finally {
    await removeOwnedTemp(directory);
  }
});

test('package.json exposes the lifecycle verifier command', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts['verify:dsh'], 'node tools/release/verify-dsh-lifecycle.mjs');
});
