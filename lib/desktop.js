/**
 * lib/desktop.js — native OS notifications through `node:child_process.spawn`, zero deps (owner C).
 *
 * Security model: notification text is untrusted session content that ends up inside a
 * PowerShell script (Windows) or an AppleScript source (macOS). Therefore
 * - the command is always built as `(command, args[])` and **never** runs through a shell
 *   (`shell: true` is never set),
 * - Windows applies XML escaping **and** PowerShell single-quote escaping (and strips control
 *   characters before both),
 * - macOS escapes `\` and `"` for AppleScript,
 * - Linux passes argv entries directly (no shell involved).
 *
 * @module notifyHook/desktop
 */

import { spawn as defaultSpawn } from 'node:child_process';

/**
 * The shape produced by `lib/format.js#formatNotification`.
 *
 * @typedef {object} DesktopNotification
 * @property {string} [title]                 notification title
 * @property {string} [body]                  notification body
 * @property {string} [text]                  `${title}\n${body}` fallback
 * @property {'info'|'warn'|'error'} [level]  severity used for the Linux urgency
 * @property {string} [status]                signal status, used when `level` is missing
 * @property {string} [tag]                   dedupe tag (Windows toast tag)
 */

/**
 * @typedef {object} DesktopOptions
 * @property {string} [platform]     `process.platform` by default
 * @property {number} [timeoutMs]    child lifetime cap in ms, default 10000
 * @property {boolean} [sound]       play a sound where the platform supports it
 * @property {string} [appId]        Windows toast AUMID override
 * @property {Function} [spawn]      injectable `child_process.spawn` (tests)
 * @property {Function} [onError]    called as `(error, { kind, command, phase })`, never throws out
 */

/**
 * @typedef {object} DesktopCommand
 * @property {string} command                                                    executable
 * @property {string[]} args                                                     argv, never a shell string
 * @property {'windows-toast'|'windows-msg'|'macos-notification'|'linux-notify-send'} kind
 */

/**
 * @typedef {object} DesktopResult
 * @property {boolean} ok
 * @property {string} kind
 * @property {string} [error]
 */

/**
 * @typedef {object} RunResult
 * @property {boolean} ok
 * @property {string} [error]
 * @property {'spawn'|'exit'|'timeout'} [phase]
 */

/** Default AUMID that makes a PowerShell-launched toast attributable to Windows PowerShell. */
export const WINDOWS_TOAST_APP_ID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/** Application name reported to the Linux notification daemon. */
export const NOTIFY_SEND_APP_NAME = 'DSH';

/** @type {number} */
export const DEFAULT_TIMEOUT_MS = 10000;

/** Frozen spawn options: no shell, no window, never detached. */
export const SPAWN_OPTIONS = Object.freeze({ stdio: 'ignore', windowsHide: true, detached: false });

/**
 * XML-escape a string for embedding in the toast document.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function escapeXml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Escape a string for a PowerShell **single-quoted** literal: `'` becomes `''`.
 * Nothing else is special inside such a literal (backticks and `$` are inert).
 *
 * @param {unknown} text
 * @returns {string}
 */
export function escapePowerShellSingleQuoted(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/'/g, "''");
}

/**
 * Escape a string for an AppleScript double-quoted literal: `\` then `"`.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function escapeAppleScript(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build the native command for a platform. Pure and deterministic: no process access,
 * no clock, no randomness — the same input always yields the same `{ command, args, kind }`.
 *
 * @param {DesktopNotification | string} notification
 * @param {DesktopOptions} [options]
 * @returns {DesktopCommand | null} `null` for an unsupported platform
 */
export function buildDesktopCommand(notification, options = {}) {
  const raw = options && typeof options === 'object' ? options : {};
  const platform = typeof raw.platform === 'string' && raw.platform !== '' ? raw.platform : process.platform;
  const parts = resolveNotificationParts(notification);

  switch (platform) {
    case 'win32':
      return buildWindowsToastCommand(parts, raw);
    case 'darwin':
      return buildMacCommand(parts, raw);
    case 'linux':
      return buildLinuxCommand(parts);
    default:
      return null;
  }
}

/**
 * Deliver a native notification. Never rejects.
 *
 * On Windows a failed toast script is retried once through `msg.exe * <text>`
 * (`kind: 'windows-msg'`); every other platform reports the failure as-is.
 *
 * @param {DesktopNotification | string} notification
 * @param {DesktopOptions} [options]
 * @returns {Promise<DesktopResult>}
 */
export async function notifyDesktop(notification, options = {}) {
  const raw = options && typeof options === 'object' ? options : {};
  const platform = typeof raw.platform === 'string' && raw.platform !== '' ? raw.platform : process.platform;
  const opts = {
    platform,
    timeoutMs: normalizeTimeout(raw.timeoutMs),
    sound: raw.sound === true,
    appId: typeof raw.appId === 'string' && raw.appId !== '' ? raw.appId : undefined,
    spawn: typeof raw.spawn === 'function' ? raw.spawn : defaultSpawn,
    onError: typeof raw.onError === 'function' ? raw.onError : null,
  };

  try {
    const command = buildDesktopCommand(notification, opts);
    if (!command) {
      const error = `unsupported platform: ${platform}`;
      reportError(opts, new Error(error), { kind: 'unsupported', command: null, phase: 'spawn' });
      return { ok: false, kind: 'unsupported', error };
    }

    const first = await runCommand(opts, command);
    if (first.ok) return { ok: true, kind: command.kind };
    reportError(opts, new Error(first.error ?? 'command failed'), {
      kind: command.kind,
      command: command.command,
      phase: first.phase ?? 'exit',
    });

    if (command.kind !== 'windows-toast') {
      return { ok: false, kind: command.kind, error: first.error ?? 'command failed' };
    }

    const fallback = buildWindowsMessageCommand(notification);
    const second = await runCommand(opts, fallback);
    if (second.ok) return { ok: true, kind: fallback.kind };
    reportError(opts, new Error(second.error ?? 'command failed'), {
      kind: fallback.kind,
      command: fallback.command,
      phase: second.phase ?? 'exit',
    });
    return {
      ok: false,
      kind: fallback.kind,
      error: `windows-toast failed (${first.error ?? 'unknown'}); windows-msg failed (${second.error ?? 'unknown'})`,
    };
  } catch (error) {
    // notifyDesktop never rejects, whatever the injected spawn throws.
    const message = error instanceof Error ? error.message || error.name : String(error);
    reportError(opts, error instanceof Error ? error : new Error(message), {
      kind: 'unknown',
      command: null,
      phase: 'spawn',
    });
    return { ok: false, kind: 'unknown', error: message };
  }
}

/**
 * Build the `msg.exe * <text>` fallback command used when the toast script cannot run.
 *
 * @param {DesktopNotification | string} notification
 * @returns {DesktopCommand}
 */
function buildWindowsMessageCommand(notification) {
  const parts = resolveNotificationParts(notification);
  const text = parts.body === '' ? parts.title : `${parts.title}: ${parts.body}`;
  return { command: 'msg.exe', args: ['*', text], kind: 'windows-msg' };
}

/**
 * @param {ReturnType<typeof resolveNotificationParts>} parts
 * @param {DesktopOptions} raw
 * @returns {DesktopCommand}
 */
function buildWindowsToastCommand(parts, raw) {
  const appId = typeof raw.appId === 'string' && raw.appId !== '' ? raw.appId : WINDOWS_TOAST_APP_ID;
  const title = escapeXml(parts.title);
  const body = escapeXml(parts.body);
  const tag = toastTagOf(parts.tag);

  const xml = [
    '<toast>',
    '<visual><binding template="ToastGeneric">',
    `<text>${title}</text>`,
    body === '' ? '' : `<text>${body}</text>`,
    '</binding></visual>',
    raw.sound === true ? '<audio src="ms-winsoundevent:Notification.Default"/>' : '',
    '</toast>',
  ].join('');

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    // The XmlDocument WinRT projection must be loaded explicitly: without this line
    // `New-Object Windows.Data.Xml.Dom.XmlDocument` throws
    // "Cannot find type ... verify that the assembly containing this type is loaded"
    // on Windows PowerShell 5.1, which is the only PowerShell that projects WinRT.
    '$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml('${escapePowerShellSingleQuoted(xml)}')`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
  ];
  if (tag !== '') lines.push(`$toast.Tag = '${escapePowerShellSingleQuoted(tag)}'`);
  lines.push(
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${escapePowerShellSingleQuoted(appId)}').Show($toast)`,
  );

  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', lines.join('; ')],
    kind: 'windows-toast',
  };
}

/**
 * @param {ReturnType<typeof resolveNotificationParts>} parts
 * @param {DesktopOptions} raw
 * @returns {DesktopCommand}
 */
function buildMacCommand(parts, raw) {
  let script = `display notification "${escapeAppleScript(parts.body)}" with title "${escapeAppleScript(parts.title)}"`;
  if (raw.sound === true) script += ' sound name "Ping"';
  return { command: 'osascript', args: ['-e', script], kind: 'macos-notification' };
}

/**
 * @param {ReturnType<typeof resolveNotificationParts>} parts
 * @returns {DesktopCommand}
 */
function buildLinuxCommand(parts) {
  // libnotify only knows low/normal/critical; `error` is not a valid urgency and makes
  // notify-send warn and fall back to normal.
  const urgency = parts.level === 'error' ? 'critical' : 'normal';
  return {
    command: 'notify-send',
    args: ['-a', NOTIFY_SEND_APP_NAME, '-u', urgency, parts.title, parts.body],
    kind: 'linux-notify-send',
  };
}

/**
 * Normalize untrusted notification text.
 *
 * Control characters are stripped (they are illegal in XML 1.0 and corrupt argv), and
 * line/paragraph separators are flattened to spaces so every platform receives a
 * single-line, inert payload.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeText(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\t\n\r\u0085\u2028\u2029]+/g, ' ')
    .trim();
}

/**
 * @param {DesktopNotification | string} notification
 * @returns {{ title: string, body: string, level: 'info'|'warn'|'error', tag: string }}
 */
function resolveNotificationParts(notification) {
  if (typeof notification === 'string') {
    return { title: NOTIFY_SEND_APP_NAME, body: sanitizeText(notification), level: 'info', tag: '' };
  }
  const source = notification && typeof notification === 'object' ? notification : {};
  let title = sanitizeText(toText(source.title));
  let body = sanitizeText(toText(source.body));

  if (body === '') {
    // `text` is `${title}\n${body}`; split it back when the structured fields are missing.
    const lines = toText(source.text).split(/\r\n|[\r\n\u0085\u2028\u2029]/);
    const head = sanitizeText(lines[0] ?? '');
    const tail = sanitizeText(lines.slice(1).join('\n'));
    if (title !== '') {
      body = head === title ? tail : sanitizeText(toText(source.text));
    } else {
      title = head;
      body = tail;
    }
  }

  return {
    title: title || NOTIFY_SEND_APP_NAME,
    body,
    level: toLevel(source),
    tag: sanitizeText(toText(source.tag)),
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * @param {Record<string, unknown>} source
 * @returns {'info'|'warn'|'error'}
 */
function toLevel(source) {
  if (source.level === 'error' || source.level === 'warn' || source.level === 'info') return source.level;
  if (source.status === 'failed' || source.status === 'error') return 'error';
  return 'info';
}

/**
 * Windows toast tags accept alphanumerics only (and cap at 16 chars); anything else makes
 * `$toast.Tag` throw. Non-conforming tags degrade to "no tag".
 *
 * @param {string} tag
 * @returns {string}
 */
function toastTagOf(tag) {
  if (typeof tag !== 'string') return '';
  return tag.replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeTimeout(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return DEFAULT_TIMEOUT_MS;
  return Math.max(0, Math.trunc(number));
}

/**
 * Run one command through the (possibly injected) spawn, bounded by `options.timeoutMs`.
 * The child is killed on timeout and `shell: true` is never used.
 *
 * @param {{ spawn: Function, timeoutMs: number }} opts
 * @param {DesktopCommand} command
 * @returns {Promise<RunResult>}
 */
function runCommand(opts, command) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;

    /** @param {RunResult} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(result);
    };

    let child;
    try {
      child = opts.spawn(command.command, command.args, SPAWN_OPTIONS);
    } catch (error) {
      finish({ ok: false, error: messageOf(error), phase: 'spawn' });
      return;
    }
    if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function') {
      finish({ ok: false, error: 'spawn() did not return a child process', phase: 'spawn' });
      return;
    }

    /** @param {number | null} code @param {string | null} [signal] */
    const onExit = (code, signal) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      if (code === null || code === undefined) {
        finish({ ok: false, error: `terminated by signal ${signal ?? 'unknown'}`, phase: 'exit' });
        return;
      }
      finish({ ok: false, error: `exited with code ${code}`, phase: 'exit' });
    };

    child.once('error', (error) => finish({ ok: false, error: messageOf(error), phase: 'spawn' }));
    child.once('exit', onExit);
    child.once('close', onExit);

    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timer = null;
        try {
          child.kill();
        } catch {
          /* the child may already be gone */
        }
        finish({ ok: false, error: `timeout after ${opts.timeoutMs}ms`, phase: 'timeout' });
      }, opts.timeoutMs);
    }
  });
}

/**
 * @param {{ onError: Function | null }} opts
 * @param {Error} error
 * @param {{ kind: string, command: string | null, phase: string }} meta
 * @returns {void}
 */
function reportError(opts, error, meta) {
  if (!opts.onError) return;
  try {
    opts.onError(error, meta);
  } catch {
    /* a throwing hook must never break delivery */
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  if (error instanceof Error) return error.message || error.name || 'error';
  return String(error);
}
