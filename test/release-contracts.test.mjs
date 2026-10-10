import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import {
  DSH_PEER_RANGE,
  assertDshPeer,
  assertManifestContract,
  isDshVersionSupported,
  redact,
  scanSecrets,
} from '../tools/release/contracts.mjs';

function reachableGitContent(revision = 'HEAD') {
  const git = (args) => execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const commits = git(['rev-list', revision]).trim().split(/\r?\n/u).filter(Boolean);
  const paths = new Set();
  const blobs = new Map();

  for (const commit of commits) {
    const entries = git(['ls-tree', '-r', '-z', '--format=%(objectname)%x09%(path)', commit])
      .split('\0')
      .filter(Boolean);
    for (const entry of entries) {
      const separator = entry.indexOf('\t');
      const object = entry.slice(0, separator);
      const path = entry.slice(separator + 1);
      paths.add(path);
      if (!blobs.has(object)) {
        blobs.set(object, { file: `${commit}:${path}`, text: git(['cat-file', 'blob', object]) });
      }
    }
  }

  return { paths, blobs: [...blobs.values()] };
}

function trackedWorkingTreeContent() {
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((file) => file && existsSync(file));
  return paths.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
}

const validManifest = () => ({
  name: 'dsh-notification-hook',
  version: '0.3.0',
  type: 'module',
  description: 'Notification hook',
  license: 'MIT',
  repository: {
    type: 'git',
    url: 'git+https://github.com/cyrillee0413-bit/dsh-notification-hook.git',
  },
  homepage: 'https://github.com/cyrillee0413-bit/dsh-notification-hook#readme',
  bugs: { url: 'https://github.com/cyrillee0413-bit/dsh-notification-hook/issues' },
  keywords: ['deepseek', 'dsh', 'notification', 'webhook', 'telegram', 'discord'],
  publishConfig: { access: 'public' },
  engines: { node: '>=22' },
  main: 'plugin.js',
  exports: {
    '.': './plugin.js',
    './client': './lib/client.js',
    './cordis.patch.yml': './cordis.patch.yml',
  },
  files: [
    'plugin.js',
    'lib',
    'locale',
    'cordis.patch.yml',
    'icon.svg',
    'LICENSE',
    'README.md',
    'README.zh.md',
    'docs/WEBHOOK-GUIDE.md',
    'docs/WEBHOOK-GUIDE.zh.md',
  ],
  dependencies: { '@deepseek-ai/schemastery': '~3.18.4' },
  peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-rc.2 <0.3.0' },
  peerDependenciesMeta: { '@deepseek-ai/dsh': { optional: true } },
});

test('a complete public manifest satisfies the release contract', () => {
  assert.doesNotThrow(() => assertManifestContract(validManifest()));
  assert.doesNotThrow(() => assertManifestContract({ ...validManifest(), version: '0.3.0-rc.0' }));
  assert.throws(() => assertManifestContract({ ...validManifest(), version: 'not-semver' }), /semantic version/i);
});

test('private or incomplete package metadata is rejected before packing', () => {
  const cases = [
    ['private package', { private: true }, /private/i],
    ['missing repository', { repository: undefined }, /repository/i],
    ['missing homepage', { homepage: undefined }, /homepage/i],
    ['missing bugs', { bugs: undefined }, /bugs/i],
    ['missing keywords', { keywords: [] }, /keyword/i],
    ['non-public publish config', { publishConfig: { access: 'restricted' } }, /public/i],
    ['missing schemastery', { dependencies: {} }, /schemastery/i],
    ['non-optional dsh peer', { peerDependenciesMeta: {} }, /optional/i],
  ];

  for (const [name, change, expected] of cases) {
    assert.throws(
      () => assertManifestContract({ ...validManifest(), ...change }),
      expected,
      name,
    );
  }
});

test('the DSH peer range keeps the tested stable and prerelease boundary', () => {
  assert.equal(DSH_PEER_RANGE, '>=0.2.0-rc.2 <0.3.0');
  assert.doesNotThrow(() => assertDshPeer(DSH_PEER_RANGE));
  assert.throws(() => assertDshPeer('^0.2.0-rc.2'), /peer range/i);

  const expectations = new Map([
    ['0.2.0-rc.2', true],
    ['0.2.0-rc.3', true],
    ['0.2.1', true],
    ['0.2.1-alpha.2', false],
    ['0.3.0', false],
  ]);
  for (const [version, expected] of expectations) {
    assert.equal(isDshVersionSupported(version, DSH_PEER_RANGE), expected, version);
  }
});

test('high-confidence credentials and local absolute paths are detected without echoing values', () => {
  const opaqueToken = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdef'].join('');
  const fictionalWebhookUuid = ['12345678', '1234', '1234', '1234', '123456789abc'].join('-');
  const samples = [
    ['telegram', `https://api.telegram.org/bot${['123456789', opaqueToken].join(':')}/sendMessage`],
    ['slack', ['https://hooks.slack.com', 'services', 'T12345678', 'B12345678', 'abcdefghijklmnopqrstuvwx'].join('/')],
    ['discord', ['https://discord.com', 'api', 'webhooks', '123456789012345678', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('/')],
    ['feishu', `https://open.feishu.cn/open-apis/bot/v2/hook/${fictionalWebhookUuid}`],
    ['wecom', `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${fictionalWebhookUuid}`],
    ['bearer', ['Authorization:', 'Bearer', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(' ')],
    ['windows path', ['C:', 'Users', 'Alice', 'secret', 'config.yml'].join('\\')],
    ['windows slash path', ['C:', 'Users', 'Alice', 'secret', 'config.yml'].join('/')],
    ['mac path', ['', 'Users', 'alice', 'private', 'config.yml'].join('/')],
    ['unix path', ['', 'home', 'alice', 'private', 'config.yml'].join('/')],
  ];

  for (const [type, value] of samples) {
    const findings = scanSecrets('fixture.txt', value);
    assert.ok(findings.length > 0, `${type} should be detected`);
    assert.equal(JSON.stringify(findings).includes(value), false, `${type} value leaked in finding`);
  }
});

test('public reachable history contains no high-confidence credentials or personal home paths', () => {
  const findings = reachableGitContent().blobs
    .flatMap(({ file, text }) => scanSecrets(file, text));

  assert.deepEqual(findings, []);
});

test('tracked source contains no hard-coded deepseek harness workspace paths', () => {
  const machinePath = /\b[A-Za-z]:[\\/]{1,2}deepseek harness(?:[\\/]{1,2}[^\r\n"'`]*)?/giu;
  const findings = trackedWorkingTreeContent().flatMap(({ file, text }) => (
    [...text.matchAll(machinePath)].map(({ index }) => ({ file, index }))
  ));

  assert.deepEqual(findings, []);
});

test('the public repository does not track internal planning or verification artifacts', () => {
  const reachablePaths = reachableGitContent().paths;
  const internalArtifacts = [
    'SPEC.md',
    'CLIENT-SPEC.md',
    'HANDOFF.md',
    'VERIFICATION.md',
    'VERIFICATION-CLIENT.md',
    'VERIFICATION-0.3.0.md',
    'docs/superpowers/plans/2026-10-09-notification-hook.md',
    'docs/superpowers/plans/2026-10-10-release-engineering.md',
    'docs/superpowers/specs/2026-10-09-notification-hook-design.md',
    'docs/superpowers/specs/2026-10-10-release-engineering-design.md',
  ];

  assert.deepEqual(internalArtifacts.filter((file) => reachablePaths.has(file)), []);
});

test('documented placeholders are not mistaken for live credentials', () => {
  const placeholderText = [
    'https://api.telegram.org/bot<token>/sendMessage',
    'https://hooks.slack.com/services/T000/B000/xxxxxxxx',
    'https://discord.com/api/webhooks/000/xxxxxxxx',
    'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=REPLACE_WITH_YOUR_KEY',
    'Authorization: Bearer xxxxxxxx',
  ].join('\n');

  assert.deepEqual(scanSecrets('README.md', placeholderText), []);
});

test('redaction removes provider credentials, bearer tokens and user-home paths', () => {
  const opaqueToken = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdef'].join('');
  const sensitive = [
    `https://api.telegram.org/bot${['123456789', opaqueToken].join(':')}/sendMessage`,
    ['Bearer', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(' '),
    ['C:', 'Users', 'Alice', 'secret', 'config.yml'].join('\\'),
  ];
  const output = redact(sensitive.join(' | '));

  for (const value of sensitive) assert.equal(output.includes(value), false);
  assert.match(output, /<redacted>/);
  assert.match(output, /<local-path>/);
});
