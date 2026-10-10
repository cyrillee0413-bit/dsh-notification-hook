import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { redact } from './contracts.mjs';

export const OWNERSHIP_MARKER = '.dsh-notification-hook-owned-temp';
const TEMP_PREFIX = 'dsh-notification-hook-';
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export async function npmInvocation() {
  const configured = process.env.npm_execpath;
  if (configured) {
    try {
      await access(configured);
      return { command: process.execPath, args: [configured] };
    } catch {
      // Fall through to the platform installation layout.
    }
  }
  if (process.platform !== 'win32') return { command: 'npm', args: [] };

  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    await access(cli);
  } catch {
    throw new Error('npm-cli.js could not be located beside the Windows Node.js runtime');
  }
  return { command: process.execPath, args: [cli] };
}

function normalizedPath(value) {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function appendChunk(chunks, chunk, state, maxBuffer, child) {
  state.bytes += chunk.length;
  if (state.bytes > maxBuffer) {
    state.overflow = true;
    child.kill();
    return;
  }
  chunks.push(chunk);
}

export function run(command, args = [], options = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    return Promise.reject(new Error('command must be a non-empty string'));
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    return Promise.reject(new Error('command arguments must be strings'));
  }

  const {
    cwd,
    env,
    input,
    maxBuffer = DEFAULT_MAX_BUFFER,
    timeoutMs = 0,
  } = options;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutState = { bytes: 0, overflow: false };
    const stderrState = { bytes: 0, overflow: false };
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        child.kill();
        finish(() => reject(new Error(`command timed out after ${timeoutMs}ms: ${redact(command)}`)));
      }, timeoutMs)
      : undefined;

    child.stdout.on('data', (chunk) => appendChunk(stdoutChunks, chunk, stdoutState, maxBuffer, child));
    child.stderr.on('data', (chunk) => appendChunk(stderrChunks, chunk, stderrState, maxBuffer, child));

    child.once('error', (error) => {
      finish(() => reject(new Error(`could not start command ${redact(command)}: ${redact(error.message)}`)));
    });

    child.once('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (stdoutState.overflow || stderrState.overflow) {
        finish(() => reject(new Error(`command output exceeded ${maxBuffer} bytes: ${redact(command)}`)));
        return;
      }
      if (code !== 0) {
        const detail = redact([stderr, stdout].filter(Boolean).join('\n').trim());
        const reason = code === null ? `terminated by signal ${signal ?? 'unknown'}` : `exited with code ${code}`;
        finish(() => reject(new Error(`command ${reason}: ${redact(command)}${detail ? `\n${detail}` : ''}`)));
        return;
      }
      finish(() => resolvePromise({ stdout, stderr, code }));
    });

    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

export async function makeOwnedTemp(label = 'work') {
  const safeLabel = String(label).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'work';
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, `${TEMP_PREFIX}${safeLabel}-`));
  const ownedPath = await realpath(directory);
  const marker = {
    owner: 'dsh-notification-hook',
    path: ownedPath,
    token: randomBytes(16).toString('hex'),
  };
  await writeFile(join(ownedPath, OWNERSHIP_MARKER), `${JSON.stringify(marker)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return ownedPath;
}

export async function removeOwnedTemp(target) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('refusing to remove an invalid temporary path');
  }

  const entry = await lstat(target);
  if (entry.isSymbolicLink()) {
    throw new Error('refusing to remove a symbolic link or junction');
  }
  if (!entry.isDirectory()) throw new Error('refusing to remove a non-directory temporary path');

  const root = await realpath(tmpdir());
  const ownedPath = await realpath(target);
  const relation = relative(root, ownedPath);
  if (!relation || relation === '.' || relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error('refusing to remove the temp root or a path outside it');
  }
  if (!basename(ownedPath).startsWith(TEMP_PREFIX)) {
    throw new Error('refusing to remove a directory without the owned temp prefix');
  }

  const markerPath = join(ownedPath, OWNERSHIP_MARKER);
  let marker;
  try {
    const markerEntry = await lstat(markerPath);
    if (markerEntry.isSymbolicLink() || !markerEntry.isFile()) {
      throw new Error('ownership marker is a symbolic link or non-file');
    }
    marker = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    throw new Error('refusing to remove a temporary directory without a valid regular ownership marker');
  }
  if (
    marker?.owner !== 'dsh-notification-hook'
    || typeof marker?.token !== 'string'
    || !/^[a-f0-9]{32}$/u.test(marker.token)
    || normalizedPath(marker.path) !== normalizedPath(ownedPath)
  ) {
    throw new Error('refusing to remove a temporary directory with a mismatched ownership marker');
  }

  const finalEntry = await lstat(ownedPath);
  if (finalEntry.isSymbolicLink() || !finalEntry.isDirectory()) {
    throw new Error('refusing redirected temporary cleanup');
  }
  await rm(ownedPath, { recursive: true, force: false });
}

export function sha256(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.once('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resolvePromise(hash.digest('hex')));
  });
}
