import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  makeOwnedTemp,
  npmInvocation,
  removeOwnedTemp,
  run,
  sha256,
} from '../tools/release/support.mjs';

const OWNERSHIP_MARKER = '.dsh-notification-hook-owned-temp';

test('run preserves argv boundaries and never invokes a command shell', async () => {
  const values = [
    'value with spaces',
    String.raw`C:\path with spaces\archive.tgz`,
    'literal & echo SHOULD_NOT_RUN',
    'literal $(echo SHOULD_NOT_RUN)',
  ];
  const result = await run(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...values],
  );

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), values);
  assert.equal(result.stderr, '');
});

test('npm is launched without a command shell on every platform', async () => {
  const invocation = await npmInvocation();
  const result = await run(invocation.command, [...invocation.args, '--version']);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  if (process.platform === 'win32') {
    assert.equal(invocation.command, process.execPath);
    assert.match(invocation.args[0], /npm-cli\.js$/i);
  }
});

test('run redacts credentials and user-home paths from child failures', async () => {
  const opaqueToken = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdef'].join('');
  const telegram = `https://api.telegram.org/bot${['123456789', opaqueToken].join(':')}/sendMessage`;
  const bearer = ['Bearer', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(' ');
  const localPath = ['C:', 'Users', 'Alice', 'private', 'config.yml'].join('\\');
  const values = [
    telegram,
    bearer,
    localPath,
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    '//registry.npmjs.org/:_authToken=npm_secret_value_1234567890',
    '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
    'https://example.test/incoming-webhook/opaque/path?signature=secret-value',
    ['', 'Users', 'alice', 'private', 'config.yml'].join('/'),
    ['C:', 'Users', 'Alice', 'private', 'config.yml'].join('/'),
  ];

  await assert.rejects(
    run(process.execPath, [
      '-e',
      `process.stderr.write(${JSON.stringify(values.join('\n'))}); process.exit(7)`,
    ]),
    (error) => {
      assert.match(error.message, /exit(?:ed)? (?:with )?code 7/i);
      assert.match(error.message, /<redacted>/);
      assert.match(error.message, /<local-path>/);
      for (const value of values) assert.equal(error.message.includes(value), false, value);
      return true;
    },
  );
});

test('temporary cleanup rejects a symlinked ownership marker', async (t) => {
  const owned = await makeOwnedTemp('marker-link');
  const markerPath = join(owned, OWNERSHIP_MARKER);
  try {
    const marker = await readFile(markerPath, 'utf8');
    const target = join(owned, 'attacker-controlled-marker.json');
    await writeFile(target, marker, 'utf8');
    await rm(markerPath);
    try {
      await symlink(target, markerPath, 'file');
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.diagnostic('file symlink creation is not permitted on this Windows host');
        return;
      }
      throw error;
    }
    await assert.rejects(
      removeOwnedTemp(owned),
      /ownership marker|marker.*(?:symbolic|link)|(?:symbolic|link).*marker/i,
    );
    await access(owned);
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
});

test('owned temporary directories carry a matching marker and can be removed', async () => {
  const directory = await makeOwnedTemp('support-test');
  const marker = JSON.parse(await readFile(join(directory, OWNERSHIP_MARKER), 'utf8'));
  assert.equal(marker.path, directory);

  await removeOwnedTemp(directory);
  await assert.rejects(access(directory));
});

test('temporary cleanup rejects a marker token that is not 128-bit lowercase hex', async () => {
  const directory = await makeOwnedTemp('bad-marker-token');
  const markerPath = join(directory, OWNERSHIP_MARKER);
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    await writeFile(markerPath, `${JSON.stringify({ ...marker, token: 'z'.repeat(32) })}\n`, 'utf8');
    await assert.rejects(removeOwnedTemp(directory), /marker|token|mismatch/i);
    await access(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('temporary cleanup rejects broad, unowned and redirected targets', async (t) => {
  await assert.rejects(removeOwnedTemp(tmpdir()), /temp root|refus/i);
  await assert.rejects(removeOwnedTemp(process.cwd()), /outside|owned|refus/i);

  const unowned = await mkdtemp(join(tmpdir(), 'dsh-notify-unowned-'));
  try {
    await assert.rejects(removeOwnedTemp(unowned), /marker|owned/i);
    await access(unowned);
  } finally {
    await rm(unowned, { recursive: true, force: true });
  }

  const owned = await makeOwnedTemp('junction-target');
  const redirected = `${owned}-junction`;
  try {
    try {
      await symlink(owned, redirected, 'junction');
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.diagnostic('junction creation is not permitted on this Windows host');
        return;
      }
      throw error;
    }
    await assert.rejects(removeOwnedTemp(redirected), /symbolic|junction|redirect/i);
    await access(owned);
  } finally {
    await rm(redirected, { recursive: true, force: true });
    await removeOwnedTemp(owned);
  }
});

test('sha256 hashes file bytes deterministically', async () => {
  const directory = await makeOwnedTemp('hash-test');
  const fixture = join(directory, 'fixture.txt');
  try {
    await writeFile(fixture, 'abc', 'utf8');
    assert.equal(
      await sha256(fixture),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  } finally {
    await removeOwnedTemp(directory);
  }
});
