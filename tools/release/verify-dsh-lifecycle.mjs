import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DSH_VERSION,
  PACKAGE_NAME,
  PNPM_VERSION,
  redact,
} from './contracts.mjs';
import { parsePackOutput } from './verify-package.mjs';
import { makeOwnedTemp, npmInvocation, removeOwnedTemp, run } from './support.mjs';

const PROFILE_NAME = 'notification-hook-ci';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function fileSpecifier(path) {
  return `file:${resolve(path).replaceAll('\\', '/')}`;
}

function isolatedEnvironment(dshHome, binDirectory) {
  const allow = [
    'ALL_PROXY', 'APPDATA', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
    'HTTP_PROXY', 'HTTPS_PROXY', 'LOCALAPPDATA', 'NODE_EXTRA_CA_CERTS',
    'NO_PROXY', 'PATHEXT', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP',
    'USERPROFILE', 'WINDIR', 'npm_config_registry',
  ];
  const env = {};
  for (const name of allow) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.CI = 'true';
  env.DSH_HOME = dshHome;
  env.PATH = `${binDirectory}${delimiter}${process.env.PATH ?? ''}`;
  return env;
}

export function resolveProfileDir(dshHome, profile) {
  invariant(typeof dshHome === 'string' && dshHome.length > 0, 'DSH home is invalid');
  invariant(typeof profile === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(profile), 'profile name is invalid');
  invariant(profile !== '.' && profile !== '..', 'profile name is invalid');
  const profilesRoot = resolve(dshHome, 'profiles');
  const profileDir = resolve(profilesRoot, profile);
  const relation = relative(profilesRoot, profileDir);
  invariant(relation === profile && !isAbsolute(relation), 'profile path escaped the isolated DSH home');
  return profileDir;
}

export async function resolveCandidateArchive({ archivePath, archiveDir } = {}) {
  invariant(
    Boolean(archivePath) !== Boolean(archiveDir),
    'provide either --archive or --archive-dir, but not both',
  );
  if (archivePath) {
    const candidate = resolve(archivePath);
    invariant(candidate.endsWith('.tgz'), 'archive must be a .tgz path');
    invariant((await stat(candidate)).isFile(), 'archive must be a regular file');
    return candidate;
  }

  const directory = resolve(archiveDir);
  invariant((await stat(directory)).isDirectory(), 'archive-dir must be a directory');
  const archives = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
    .map((entry) => resolve(directory, entry.name));
  invariant(archives.length === 1, `archive-dir must contain exactly one .tgz file; found ${archives.length}`);
  return archives[0];
}

export async function inspectProfileState({ dshHome, profile, dumpConfig = '' }) {
  const profileDir = resolveProfileDir(dshHome, profile);
  const profileManifest = await readJson(join(profileDir, 'package.json'));
  const packageDir = join(profileDir, 'node_modules', PACKAGE_NAME);
  const installed = await isDirectory(packageDir);
  const installedManifest = installed ? await readJson(join(packageDir, 'package.json')) : undefined;
  const bundles = profileManifest.dsh?.profile?.bundles;
  const hasHeader = /^# == dsh-notification-hook\s*$/mu.test(dumpConfig);
  const hasRow = /^- id:\s*notify-hook\s*$/mu.test(dumpConfig)
    && /^\s+name:\s*['"]?dsh-notification-hook['"]?\s*$/mu.test(dumpConfig);
  return {
    profileDir,
    dependency: profileManifest.dependencies?.[PACKAGE_NAME],
    bundle: Array.isArray(bundles) && bundles.includes(PACKAGE_NAME),
    installed,
    installedVersion: installedManifest?.version,
    notifyHook: hasHeader && hasRow,
  };
}

export function assertInstalledState(state, { version, specifier }) {
  invariant(state?.dependency === specifier, `dependency specifier mismatch: ${String(state?.dependency)}`);
  invariant(state?.bundle === true, 'bundle entry is missing');
  invariant(state?.installed === true, 'installed package directory is missing');
  invariant(state?.installedVersion === version, `installedVersion mismatch: ${String(state?.installedVersion)}`);
  invariant(state?.notifyHook === true, 'notifyHook row is missing from composed config');
  return state;
}

export function assertRemovedState(state) {
  invariant(state?.dependency === undefined, 'dependency residue remains after remove');
  invariant(state?.bundle === false, 'bundle residue remains after remove');
  invariant(state?.installed === false, 'installed package directory residue remains after remove');
  invariant(state?.notifyHook === false, 'notifyHook row residue remains after remove');
  return state;
}

async function assertNativeConfig(profileDir) {
  const entry = join(profileDir, 'node_modules', PACKAGE_NAME, 'plugin.js');
  const plugin = await import(`${pathToFileURL(entry).href}?lifecycle=${Date.now()}-${Math.random()}`);
  invariant(plugin.Config?.[Symbol.for('schemastery')] === true, 'profile package did not resolve native Schemastery');
  invariant(plugin.Config?.meta?.volatile === true, 'profile package Config is not volatile');
}

async function createOldCandidate({ archivePath, runnerRoot, npm, runCommand }) {
  const consumer = join(runnerRoot, 'candidate-consumer');
  const oldSource = join(runnerRoot, 'old-source');
  const oldOutput = join(runnerRoot, 'old-dist');
  await mkdir(consumer, { recursive: true });
  await mkdir(oldOutput, { recursive: true });
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8');
  await runCommand(
    npm.command,
    [...npm.args, 'install', '--ignore-scripts', '--no-audit', '--no-fund', archivePath],
    { cwd: consumer },
  );
  const installed = join(consumer, 'node_modules', PACKAGE_NAME);
  const candidateManifest = await readJson(join(installed, 'package.json'));
  await cp(installed, oldSource, { recursive: true });
  const oldVersion = `${candidateManifest.version}-ci-old.0`;
  await writeFile(
    join(oldSource, 'package.json'),
    `${JSON.stringify({ ...candidateManifest, version: oldVersion }, null, 2)}\n`,
    'utf8',
  );
  const packed = await runCommand(
    npm.command,
    [...npm.args, 'pack', '--json', '--pack-destination', oldOutput],
    { cwd: oldSource },
  );
  const record = parsePackOutput(packed.stdout);
  invariant(record.version === oldVersion, 'old candidate archive has the wrong version');
  const oldArchive = join(oldOutput, record.filename);
  await stat(oldArchive);
  return { candidateVersion: candidateManifest.version, oldArchive, oldVersion };
}

export async function verifyLifecycle({ archivePath, archiveDir, runCommand = run } = {}) {
  const candidateArchive = await resolveCandidateArchive({ archivePath, archiveDir });

  let runnerRoot;
  try {
    runnerRoot = await makeOwnedTemp('dsh-lifecycle');
    const npm = await npmInvocation();
    await writeFile(join(runnerRoot, 'package.json'), '{"private":true}\n', 'utf8');
    await runCommand(
      npm.command,
      [...npm.args, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `@deepseek-ai/dsh@${DSH_VERSION}`, `pnpm@${PNPM_VERSION}`],
      { cwd: runnerRoot },
    );

    const dshHome = join(runnerRoot, 'dsh-home');
    const binDirectory = join(runnerRoot, 'node_modules', '.bin');
    const dshCli = join(runnerRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const pnpmCli = join(runnerRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    const env = isolatedEnvironment(dshHome, binDirectory);

    const pnpmVersion = (await runCommand(process.execPath, [pnpmCli, '--version'], { cwd: runnerRoot, env })).stdout.trim();
    invariant(pnpmVersion === PNPM_VERSION, `pnpm version mismatch: ${pnpmVersion}`);
    const dshVersion = (await runCommand(process.execPath, [dshCli, '--version'], { cwd: runnerRoot, env })).stdout.trim();
    invariant(dshVersion === DSH_VERSION, `DSH version mismatch: ${dshVersion}`);

    const old = await createOldCandidate({
      archivePath: candidateArchive,
      runnerRoot,
      npm,
      runCommand,
    });
    const profileDir = resolveProfileDir(dshHome, PROFILE_NAME);
    const dsh = (...args) => runCommand(process.execPath, [dshCli, ...args], { cwd: runnerRoot, env });
    const stateWithDump = async () => {
      const dump = await dsh('--profile', PROFILE_NAME, '--dump-config');
      return inspectProfileState({ dshHome, profile: PROFILE_NAME, dumpConfig: dump.stdout });
    };
    const stages = [];

    await dsh('plugin', '--profile', PROFILE_NAME, 'add', old.oldArchive);
    assertInstalledState(await stateWithDump(), {
      version: old.oldVersion,
      specifier: fileSpecifier(old.oldArchive),
    });
    await assertNativeConfig(profileDir);
    stages.push({ name: 'install-old', version: old.oldVersion });

    await dsh('plugin', '--profile', PROFILE_NAME, 'add', candidateArchive);
    assertInstalledState(await stateWithDump(), {
      version: old.candidateVersion,
      specifier: fileSpecifier(candidateArchive),
    });
    await assertNativeConfig(profileDir);
    stages.push({ name: 'replace-candidate', version: old.candidateVersion });
    stages.push({ name: 'dump-config', notifyHook: true });

    await dsh('plugin', '--profile', PROFILE_NAME, 'remove', PACKAGE_NAME);
    assertRemovedState(await stateWithDump());
    stages.push({ name: 'remove', clean: true });

    await dsh('plugin', '--profile', PROFILE_NAME, 'add', candidateArchive);
    assertInstalledState(await stateWithDump(), {
      version: old.candidateVersion,
      specifier: fileSpecifier(candidateArchive),
    });
    await assertNativeConfig(profileDir);
    stages.push({ name: 'reinstall', version: old.candidateVersion });

    return {
      dshVersion,
      pnpmVersion,
      profile: PROFILE_NAME,
      stages,
    };
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : String(error)));
  } finally {
    if (runnerRoot) await removeOwnedTemp(runnerRoot);
  }
}

function readCliOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  invariant(process.argv[index + 1], `${name} requires a value`);
  return process.argv[index + 1];
}

async function main() {
  process.stdout.write(`${JSON.stringify(await verifyLifecycle({
    archivePath: readCliOption('--archive'),
    archiveDir: readCliOption('--archive-dir'),
  }))}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
