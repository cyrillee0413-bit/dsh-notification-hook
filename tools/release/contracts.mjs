export const PACKAGE_NAME = 'dsh-notification-hook';
export const DSH_VERSION = '0.2.0-rc.2';
export const DSH_PEER_RANGE = '>=0.2.0-rc.2 <0.3.0';
export const PNPM_VERSION = '11.25.0';

const REPOSITORY_URL = 'git+https://github.com/cyrillee0413-bit/dsh-notification-hook.git';
const HOMEPAGE_URL = 'https://github.com/cyrillee0413-bit/dsh-notification-hook#readme';
const BUGS_URL = 'https://github.com/cyrillee0413-bit/dsh-notification-hook/issues';
const REQUIRED_KEYWORDS = ['deepseek', 'dsh', 'notification', 'webhook', 'telegram', 'discord'];
const REQUIRED_FILES = [
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
];

const SECRET_RULES = [
  ['telegram-token', /https?:\/\/api\.telegram\.org\/bot\d{6,}:[A-Za-z0-9_-]{20,}[^\s"']*/giu],
  ['slack-webhook', /https?:\/\/hooks\.slack\.com\/services\/[A-Z0-9]{8,}\/[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}[^\s"']*/giu],
  ['discord-webhook', /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{10,}\/[A-Za-z0-9._-]{20,}[^\s"']*/giu],
  ['feishu-webhook', /https?:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[0-9a-f]{8}-[0-9a-f-]{27}[^\s"']*/giu],
  ['wecom-webhook', /https?:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[0-9a-f]{8}-[0-9a-f-]{27}[^\s"']*/giu],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/gu],
  ['windows-home-path', /\b[A-Za-z]:[\\/]Users[\\/][^\\/\s]+(?:[\\/][^\s"']*)?/gu],
  ['mac-home-path', /\/Users\/[^/\s]+(?:\/[^\s"']*)?/gu],
  ['unix-home-path', /\/home\/[^/\s]+(?:\/[^\s"']*)?/gu],
];

const DIAGNOSTIC_REDACTIONS = [
  [/(\bAuthorization\s*:\s*)[^\r\n]+/giu, '$1<redacted>'],
  [/(_authToken\s*=\s*)[^\s"']+/giu, '$1<redacted>'],
  [/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, '<redacted>'],
  [/\b[A-Za-z]:\/Users\/[^/\s]+(?:\/[^\s"']*)?/gu, '<local-path>'],
  [/\/Users\/[^/\s]+(?:\/[^\s"']*)?/gu, '<local-path>'],
  [/https?:\/\/[^\s"'<>]+/giu, '<redacted-url>'],
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseSemver(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) throw new Error(`invalid semantic version: ${String(value)}`);
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((identifier) => /^\d+$/u.test(identifier) && /^0\d+/u.test(identifier))) {
    throw new Error(`invalid semantic version: ${String(value)}`);
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  };
}

function compareIdentifiers(left, right) {
  const leftNumber = /^\d+$/.test(left);
  const rightNumber = /^\d+$/.test(right);
  if (leftNumber && rightNumber) return Number(left) - Number(right);
  if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
  return left.localeCompare(right);
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const compared = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function isDshVersionSupported(version, range = DSH_PEER_RANGE) {
  const match = /^>=([^\s]+)\s+<([^\s]+)$/.exec(range);
  if (!match) throw new Error(`unsupported DSH peer range syntax: ${String(range)}`);
  const candidate = parseSemver(version);
  const lower = parseSemver(match[1]);
  const upper = parseSemver(match[2]);
  if (compareSemver(candidate, lower) < 0 || compareSemver(candidate, upper) >= 0) return false;

  if (candidate.prerelease.length > 0) {
    const comparators = [lower, upper];
    const admitsPrereleaseTuple = comparators.some((comparator) => (
      comparator.prerelease.length > 0
      && comparator.core.every((part, index) => part === candidate.core[index])
    ));
    if (!admitsPrereleaseTuple) return false;
  }
  return true;
}

export function assertDshPeer(range) {
  invariant(range === DSH_PEER_RANGE, `DSH peer range must be exactly ${DSH_PEER_RANGE}`);
  invariant(isDshVersionSupported(DSH_VERSION, range), `DSH peer range rejects tested runtime ${DSH_VERSION}`);
}

export function assertManifestContract(manifest) {
  invariant(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'package manifest must be an object');
  invariant(manifest.private !== true, 'public package must not be private');
  invariant(manifest.name === PACKAGE_NAME, `package name must be ${PACKAGE_NAME}`);
  parseSemver(manifest.version);
  invariant(manifest.license === 'MIT', 'package license must be MIT');
  invariant(manifest.repository?.type === 'git' && manifest.repository?.url === REPOSITORY_URL, 'repository metadata is invalid');
  invariant(manifest.homepage === HOMEPAGE_URL, 'homepage metadata is invalid');
  invariant(manifest.bugs?.url === BUGS_URL, 'bugs metadata is invalid');
  invariant(manifest.publishConfig?.access === 'public', 'publishConfig.access must be public');
  for (const keyword of REQUIRED_KEYWORDS) {
    invariant(manifest.keywords?.includes(keyword), `missing package keyword: ${keyword}`);
  }
  invariant(manifest.dependencies?.['@deepseek-ai/schemastery'] === '~3.18.4', 'Schemastery runtime dependency is missing or changed');
  assertDshPeer(manifest.peerDependencies?.['@deepseek-ai/dsh']);
  invariant(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional === true, 'DSH peer must remain optional');
  for (const file of REQUIRED_FILES) {
    invariant(manifest.files?.includes(file), `missing package file whitelist entry: ${file}`);
  }
  return manifest;
}

export function scanSecrets(file, text) {
  if (typeof text !== 'string') return [];
  const findings = [];
  for (const [type, pattern] of SECRET_RULES) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      findings.push({ file, type, index: match.index });
    }
  }
  return findings;
}

export function redact(value) {
  let output = String(value ?? '');
  for (const [type, pattern] of SECRET_RULES) {
    const replacement = type.endsWith('-path') ? '<local-path>' : '<redacted>';
    output = output.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }
  for (const [pattern, replacement] of DIAGNOSTIC_REDACTIONS) {
    output = output.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }
  return output;
}
