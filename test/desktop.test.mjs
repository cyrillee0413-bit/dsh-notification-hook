/**
 * test/desktop.test.mjs — owner C.
 *
 * Pure/injected only: `notifyDesktop` always receives a fake `spawn`, so no real process is
 * ever started and no real notification is ever shown.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  SPAWN_OPTIONS,
  WINDOWS_TOAST_APP_ID,
  buildDesktopCommand,
  escapeAppleScript,
  escapePowerShellSingleQuoted,
  escapeXml,
  notifyDesktop,
} from '../lib/desktop.js';

/**
 * A plan for one fake spawn call.
 *
 * @typedef {object} SpawnPlan
 * @property {number | null} [code]  exit code (default 0)
 * @property {string | null} [signal]
 * @property {Error} [error]         emit an `error` event instead of exiting
 * @property {Error} [throws]        throw synchronously out of spawn()
 * @property {boolean} [hang]        never settles (used for timeout tests)
 */

/**
 * Build an injectable spawn that records every call and replays the given plans.
 *
 * @param {SpawnPlan[]} [plans]
 * @returns {{ spawn: Function, calls: Array<{ command: string, args: string[], options: object,
 *            kills: string[], plan: SpawnPlan }> }}
 */
function createFakeSpawn(plans = []) {
  const calls = [];
  const queue = [...plans];

  /**
   * @param {string} command
   * @param {string[]} args
   * @param {object} options
   */
  const spawn = (command, args, options) => {
    const plan = queue.shift() ?? { code: 0 };
    const child = new EventEmitter();
    /** @type {string[]} */
    const kills = [];
    child.kill = (signal) => {
      kills.push(signal ?? 'SIGTERM');
      return true;
    };

    calls.push({ command, args, options, kills, plan });
    if (plan.throws) throw plan.throws;

    setImmediate(() => {
      if (plan.hang) return;
      if (plan.error) {
        child.emit('error', plan.error);
        return;
      }
      child.emit('exit', plan.code === undefined ? 0 : plan.code, plan.signal ?? null);
    });

    return child;
  };

  return { spawn, calls };
}

/**
 * Extract every PowerShell single-quoted literal from a script. Throws when a literal is never
 * terminated, which is exactly what an escaping payload would have to cause.
 *
 * @param {string} script
 * @returns {string[]} un-doubled literal contents, in source order
 */
function extractPowerShellLiterals(script) {
  /** @type {string[]} */
  const literals = [];
  let index = 0;

  while (index < script.length) {
    if (script[index] !== "'") {
      index += 1;
      continue;
    }
    let value = '';
    let cursor = index + 1;
    for (;;) {
      if (cursor >= script.length) throw new Error('unterminated PowerShell single-quoted literal');
      if (script[cursor] === "'") {
        if (script[cursor + 1] === "'") {
          value += "'";
          cursor += 2;
          continue;
        }
        break;
      }
      value += script[cursor];
      cursor += 1;
    }
    literals.push(value);
    index = cursor + 1;
  }

  return literals;
}

/**
 * Extract every AppleScript double-quoted literal, resolving `\"` and `\\`.
 *
 * @param {string} script
 * @returns {string[]}
 */
function extractAppleScriptLiterals(script) {
  /** @type {string[]} */
  const literals = [];
  let index = 0;

  while (index < script.length) {
    if (script[index] !== '"') {
      index += 1;
      continue;
    }
    let value = '';
    let cursor = index + 1;
    for (;;) {
      if (cursor >= script.length) throw new Error('unterminated AppleScript string');
      const char = script[cursor];
      if (char === '\\') {
        value += script[cursor + 1] ?? '';
        cursor += 2;
        continue;
      }
      if (char === '"') break;
      value += char;
      cursor += 1;
    }
    literals.push(value);
    index = cursor + 1;
  }

  return literals;
}

/**
 * The toast XML document embedded in a generated PowerShell script.
 *
 * @param {string} script
 * @returns {string}
 */
function xmlOf(script) {
  const documents = extractPowerShellLiterals(script).filter((literal) => literal.startsWith('<toast>'));
  assert.equal(documents.length, 1, 'exactly one toast document must be embedded');
  return documents[0];
}

// ---------------------------------------------------------------------------
// escaping primitives
// ---------------------------------------------------------------------------

test('escapeXml escapes the five XML metacharacters', () => {
  assert.equal(escapeXml(`<&>"'`), '&lt;&amp;&gt;&quot;&apos;');
  assert.equal(escapeXml('plain'), 'plain');
  assert.equal(escapeXml('&amp;'), '&amp;amp;');
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(undefined), '');
});

test('escapePowerShellSingleQuoted doubles quotes so a literal cannot be closed', () => {
  const payload = "' ; Remove-Item -Recurse C:\\ -Force ; '";
  assert.equal(escapePowerShellSingleQuoted(payload), "'' ; Remove-Item -Recurse C:\\ -Force ; ''");
  // Composing both layers must leave no raw apostrophe at all.
  assert.equal(escapePowerShellSingleQuoted(escapeXml(payload)).includes("'"), false);
});

test('escapeAppleScript escapes backslashes first and then quotes', () => {
  const backslash = String.fromCharCode(92);
  const quote = String.fromCharCode(34);

  assert.equal(escapeAppleScript(`say ${quote}hi${quote}`), `say ${backslash}${quote}hi${backslash}${quote}`);
  assert.equal(escapeAppleScript(`C:${backslash}tmp`), `C:${backslash}${backslash}tmp`);
  // Escaping order matters: a literal backslash-quote must be escaped exactly once.
  assert.equal(escapeAppleScript(`${backslash}${quote}`), `${backslash}${backslash}${backslash}${quote}`);
  // Round trip through the AppleScript literal tokenizer.
  assert.deepEqual(extractAppleScriptLiterals(`${quote}${escapeAppleScript(`a${backslash}b${quote}c`)}${quote}`), [
    `a${backslash}b${quote}c`,
  ]);
});

// ---------------------------------------------------------------------------
// buildDesktopCommand
// ---------------------------------------------------------------------------

test('buildDesktopCommand is deterministic and shape-stable on every supported platform', () => {
  const notification = {
    title: '❌ 任务失败',
    body: '第一行\n第二行',
    level: 'error',
    status: 'failed',
    tag: 'dsh:failed:session-c4460152',
  };

  for (const platform of ['win32', 'darwin', 'linux']) {
    const first = buildDesktopCommand(notification, { platform });
    const second = buildDesktopCommand(notification, { platform });

    assert.deepEqual(first, second, `${platform} must be deterministic`);
    assert.ok(first);
    assert.deepEqual(Object.keys(first).sort(), ['args', 'command', 'kind']);
    assert.equal(typeof first.command, 'string');
    assert.ok(Array.isArray(first.args));
    assert.ok(first.args.every((arg) => typeof arg === 'string'), 'argv entries are always strings');
  }
});

test('buildDesktopCommand returns null for unsupported platforms', () => {
  assert.equal(buildDesktopCommand({ title: 'T' }, { platform: 'freebsd' }), null);
  assert.equal(buildDesktopCommand({ title: 'T' }, { platform: 'aix' }), null);
  assert.deepEqual(
    buildDesktopCommand({ title: 'T' }, { platform: '' }),
    buildDesktopCommand({ title: 'T' }),
    'an empty platform falls back to process.platform',
  );
});

test('buildDesktopCommand tolerates malformed notifications', () => {
  for (const input of [undefined, null, {}, '', 'plain text', 42, { title: null, body: undefined }]) {
    for (const platform of ['win32', 'darwin', 'linux', 'freebsd']) {
      assert.doesNotThrow(() => buildDesktopCommand(input, { platform }), `${platform} ${String(input)}`);
    }
  }
  assert.doesNotThrow(() => buildDesktopCommand({ title: 'T' }));
});

test('linux: notify-send argv, urgency "critical" only for failures', () => {
  assert.deepEqual(buildDesktopCommand({ title: '✅ 任务完成', body: '耗时 2m13s' }, { platform: 'linux' }), {
    command: 'notify-send',
    args: ['-a', 'DSH', '-u', 'normal', '✅ 任务完成', '耗时 2m13s'],
    kind: 'linux-notify-send',
  });

  assert.deepEqual(
    buildDesktopCommand({ title: '❌ 任务失败', body: 'boom', level: 'error' }, { platform: 'linux' }).args,
    ['-a', 'DSH', '-u', 'critical', '❌ 任务失败', 'boom'],
  );
  assert.deepEqual(
    buildDesktopCommand({ title: 'T', body: 'B', status: 'failed' }, { platform: 'linux' }).args,
    ['-a', 'DSH', '-u', 'critical', 'T', 'B'],
  );

  // `text` is the last-resort source and is split back into title/body safely.
  const textOnly = buildDesktopCommand({ text: '✅ 任务完成\n第三轮结束' }, { platform: 'linux' });
  assert.deepEqual(textOnly.args, ['-a', 'DSH', '-u', 'normal', '✅ 任务完成', '第三轮结束']);
});

test('darwin: osascript argv, sound only when requested', () => {
  assert.deepEqual(buildDesktopCommand({ title: 'Title', body: 'Body' }, { platform: 'darwin' }), {
    command: 'osascript',
    args: ['-e', 'display notification "Body" with title "Title"'],
    kind: 'macos-notification',
  });

  const loud = buildDesktopCommand({ title: 'Title', body: 'Body' }, { platform: 'darwin', sound: true });
  assert.equal(loud.args[1], 'display notification "Body" with title "Title" sound name "Ping"');

  const silent = buildDesktopCommand({ title: 'Title', body: 'Body' }, { platform: 'darwin', sound: false });
  assert.equal(silent.args[1].includes('sound name'), false);
});

test('win32: powershell toast argv with a ToastGeneric document', () => {
  const command = buildDesktopCommand(
    { title: 'Done', body: 'Turn 3', tag: 'dsh:completed:session-c4' },
    { platform: 'win32' },
  );

  assert.equal(command.command, 'powershell.exe');
  assert.equal(command.kind, 'windows-toast');
  assert.deepEqual(command.args.slice(0, 5), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
  ]);
  assert.equal(command.args.length, 6, 'the script is a single argv entry');

  const script = command.args[5];
  assert.equal(
    xmlOf(script),
    '<toast><visual><binding template="ToastGeneric"><text>Done</text><text>Turn 3</text></binding></visual></toast>',
  );
  assert.ok(script.includes('Windows.UI.Notifications.ToastNotificationManager'));
  // Regression: the XmlDocument WinRT projection must be loaded explicitly before
  // New-Object, or Windows PowerShell 5.1 throws "Cannot find type
  // [Windows.Data.Xml.Dom.XmlDocument]" and every toast silently fails.
  const xmlProjection = script.indexOf(
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
  );
  const xmlConstruction = script.indexOf('New-Object Windows.Data.Xml.Dom.XmlDocument');
  assert.notEqual(xmlProjection, -1, 'the XmlDocument WinRT projection must be loaded');
  assert.notEqual(xmlConstruction, -1, 'XmlDocument must be constructed');
  assert.ok(
    xmlProjection < xmlConstruction,
    'the XmlDocument projection must be loaded before New-Object uses it',
  );
  assert.ok(script.includes('ToastGeneric'));
  assert.ok(script.includes("$ErrorActionPreference = 'Stop'"));
  assert.ok(script.includes(`CreateToastNotifier('${WINDOWS_TOAST_APP_ID}')`), 'default AUMID is used');
  assert.ok(script.includes("$toast.Tag = 'dshcompletedsess'"), 'toast tags are reduced to alphanumerics');
  assert.equal(script.includes('<audio'), false);

  const custom = buildDesktopCommand({ title: 'T' }, { platform: 'win32', appId: 'com.example.DSH' });
  assert.ok(custom.args[5].includes("CreateToastNotifier('com.example.DSH')"));

  const loud = buildDesktopCommand({ title: 'T' }, { platform: 'win32', sound: true });
  assert.ok(loud.args[5].includes('<audio src="ms-winsoundevent:Notification.Default"/>'));
});

// ---------------------------------------------------------------------------
// injection hardening
// ---------------------------------------------------------------------------

test('win32 injection: "…Remove-Item…" payload stays inert literal text', () => {
  const payload = "' ; Remove-Item -Recurse C:\\ -Force ; '";
  const command = buildDesktopCommand({ title: payload, body: 'body' }, { platform: 'win32' });
  const script = /** @type {string} */ (command.args.at(-1));

  // Throws if the payload managed to terminate a literal early.
  const literals = extractPowerShellLiterals(script);
  const escaped = escapeXml(payload);
  assert.equal(escaped, '&apos; ; Remove-Item -Recurse C:\\ -Force ; &apos;');

  const carriers = literals.filter((literal) => literal.includes('Remove-Item'));
  assert.equal(carriers.length, 1, 'the payload may appear in exactly one literal');
  assert.ok(
    carriers[0].includes(escaped),
    'the *whole* payload, including both quotes, must sit inside one literal',
  );
  assert.equal(carriers[0], xmlOf(script), 'the carrier is the toast document, nothing else');
  assert.equal(carriers[0].includes(`<text>${escaped}</text>`), true);

  // No raw quote of the payload survives, in either direction of the injection.
  for (const fragment of ["' ; Remove-Item", "Remove-Item -Recurse C:\\ -Force ; '", "'' ; Remove-Item"]) {
    assert.equal(script.includes(fragment), false, `raw fragment must not survive: ${fragment}`);
  }
  assert.equal(
    literals.some((literal) => literal.trim() === 'Remove-Item -Recurse C:\\ -Force'),
    false,
    'the payload must never become a standalone statement',
  );
  assert.equal(script.split('Remove-Item -Recurse').length, 2, 'the payload appears exactly once');
  assert.equal(command.args.length, 6, 'the payload cannot add argv entries');
});

test('win32 injection: XML-breaking title <&>" stays inside its text node', () => {
  const title = '<&>"';
  const command = buildDesktopCommand({ title, body: 'safe' }, { platform: 'win32' });
  const script = /** @type {string} */ (command.args.at(-1));
  const xml = xmlOf(script);

  assert.equal(escapeXml(title), '&lt;&amp;&gt;&quot;');
  assert.ok(xml.includes('<text>&lt;&amp;&gt;&quot;</text>'));
  assert.equal(script.includes('<&>"'), false);
  assert.equal((xml.match(/<text>/g) ?? []).length, 2, 'no element can be injected');
  // The only raw double quotes in the document are the template attribute's own.
  assert.equal((xml.match(/"/g) ?? []).length, 2);
  assert.equal((xml.match(/<binding template="ToastGeneric">/g) ?? []).length, 1);

  const element = '</text><text>injected</text>';
  const evil = buildDesktopCommand({ title: element, body: 'b' }, { platform: 'win32' });
  const evilXml = xmlOf(/** @type {string} */ (evil.args.at(-1)));
  assert.equal((evilXml.match(/<text>/g) ?? []).length, 2);
  assert.equal(evilXml.includes('<text>injected</text>'), false);
  assert.ok(evilXml.includes('&lt;/text&gt;&lt;text&gt;injected&lt;/text&gt;'));

  // An attribute-escape attempt cannot break the template either.
  const attribute = '" template="evil';
  const attrCommand = buildDesktopCommand({ title: attribute, body: 'b' }, { platform: 'win32' });
  const attrXml = xmlOf(/** @type {string} */ (attrCommand.args.at(-1)));
  assert.equal((attrXml.match(/"/g) ?? []).length, 2, 'user text contributes no raw quotes');
  assert.equal(attrXml.includes('" template="evil'), false);
  assert.ok(attrXml.includes('<text>&quot; template=&quot;evil</text>'));
});

test('darwin injection: quotes in the title cannot break out of the AppleScript string', () => {
  const payload = '" & (do shell script "rm -rf /") & "';
  const command = buildDesktopCommand({ title: payload, body: 'body' }, { platform: 'darwin' });
  const script = /** @type {string} */ (command.args.at(-1));

  // Throws if the payload closed the string early; the raw payload must be one literal.
  assert.deepEqual(extractAppleScriptLiterals(script), ['body', payload]);
  assert.equal(script.includes(payload), false, 'the unescaped, executable form never reaches argv');
  assert.ok(script.includes(escapeAppleScript(payload)));
  assert.equal(script.split('do shell script').length, 2);
});

test('control characters and newlines are stripped or flattened before argv', () => {
  const command = buildDesktopCommand({ title: 'a\nb', body: 'x\ty' }, { platform: 'darwin' });
  const script = /** @type {string} */ (command.args.at(-1));
  assert.equal(script, 'display notification "x y" with title "a b"');
  assert.equal(/[\u0000-\u001F\u007F]/.test(script), false);

  const nul = buildDesktopCommand({ title: 'n\u0000u', body: 'b\u0007c' }, { platform: 'linux' });
  assert.deepEqual(nul.args, ['-a', 'DSH', '-u', 'normal', 'nu', 'bc']);

  const toast = buildDesktopCommand({ title: 'a\r\nb', body: 'c\u001bd' }, { platform: 'win32' });
  const toastScript = /** @type {string} */ (toast.args.at(-1));
  assert.equal(/[\u0000-\u001F\u007F]/.test(toastScript), false, 'toast XML must stay valid');
  assert.ok(xmlOf(toastScript).includes('<text>a b</text>'));
  assert.ok(xmlOf(toastScript).includes('<text>cd</text>'));
});

// ---------------------------------------------------------------------------
// notifyDesktop (fake spawn only)
// ---------------------------------------------------------------------------

test('notifyDesktop resolves { ok: true } on exit code 0 and never uses a shell', async () => {
  const fake = createFakeSpawn([{ code: 0 }]);
  const result = await notifyDesktop({ title: 'Done', body: 'Turn 3 finished' }, { platform: 'linux', spawn: fake.spawn });

  assert.deepEqual(result, { ok: true, kind: 'linux-notify-send' });
  assert.equal(fake.calls.length, 1);

  const [call] = fake.calls;
  assert.equal(call.command, 'notify-send');
  assert.deepEqual(call.args, ['-a', 'DSH', '-u', 'normal', 'Done', 'Turn 3 finished']);
  assert.deepEqual(call.options, { stdio: 'ignore', windowsHide: true, detached: false });
  assert.equal('shell' in call.options, false);
  assert.equal(call.options.shell, undefined);
  assert.deepEqual(call.kills, [], 'a clean exit must not kill the child');
  assert.equal(SPAWN_OPTIONS.shell, undefined);
});

test('notifyDesktop reports a non-zero exit and calls onError once', async () => {
  const fake = createFakeSpawn([{ code: 3 }]);
  /** @type {Array<{ message: string, meta: object }>} */
  const errors = [];

  const result = await notifyDesktop(
    { title: 'T', body: 'B' },
    {
      platform: 'darwin',
      spawn: fake.spawn,
      onError: (error, meta) => errors.push({ message: error.message, meta }),
    },
  );

  assert.deepEqual(result, { ok: false, kind: 'macos-notification', error: 'exited with code 3' });
  assert.equal(fake.calls.length, 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].meta, { kind: 'macos-notification', command: 'osascript', phase: 'exit' });
});

test('notifyDesktop falls back once to msg.exe when the toast script fails', async () => {
  const fake = createFakeSpawn([{ code: 1 }, { code: 0 }]);

  const result = await notifyDesktop({ title: 'Title', body: 'Body' }, { platform: 'win32', spawn: fake.spawn });

  assert.deepEqual(result, { ok: true, kind: 'windows-msg' });
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].command, 'powershell.exe');
  assert.equal(fake.calls[0].args.length, 6);
  assert.equal(fake.calls[1].command, 'msg.exe');
  assert.deepEqual(fake.calls[1].args, ['*', 'Title: Body']);
  assert.deepEqual(fake.calls[1].options, { stdio: 'ignore', windowsHide: true, detached: false });
  assert.equal('shell' in fake.calls[1].options, false);
});

test('notifyDesktop reports both failures when the msg.exe fallback fails too', async () => {
  const fake = createFakeSpawn([{ code: 1 }, { code: 4 }]);

  const result = await notifyDesktop({ title: 'T', body: 'B' }, { platform: 'win32', spawn: fake.spawn });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'windows-msg');
  assert.match(String(result.error), /windows-toast failed \(exited with code 1\)/);
  assert.match(String(result.error), /windows-msg failed \(exited with code 4\)/);
  assert.equal(fake.calls.length, 2, 'the fallback runs exactly once');
});

test('notifyDesktop falls back when spawn itself throws', async () => {
  const fake = createFakeSpawn([{ throws: new Error('spawn EPERM') }, { code: 0 }]);

  const result = await notifyDesktop({ title: 'T', body: 'B' }, { platform: 'win32', spawn: fake.spawn });

  assert.deepEqual(result, { ok: true, kind: 'windows-msg' });
  assert.equal(fake.calls.length, 2);
});

test('notifyDesktop kills the child on timeout and reports it', async () => {
  const fake = createFakeSpawn([{ hang: true }]);

  const result = await notifyDesktop(
    { title: 'T', body: 'B' },
    { platform: 'linux', spawn: fake.spawn, timeoutMs: 30 },
  );

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'linux-notify-send');
  assert.equal(result.error, 'timeout after 30ms');
  assert.deepEqual(fake.calls[0].kills, ['SIGTERM']);
});

test('notifyDesktop kills both children when the win32 toast times out', async () => {
  const fake = createFakeSpawn([{ hang: true }, { hang: true }]);

  const result = await notifyDesktop(
    { title: 'T', body: 'B' },
    { platform: 'win32', spawn: fake.spawn, timeoutMs: 25 },
  );

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'windows-msg');
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[0].kills, ['SIGTERM']);
  assert.deepEqual(fake.calls[1].kills, ['SIGTERM']);
  assert.equal(fake.calls[1].command, 'msg.exe');
});

test('notifyDesktop surfaces spawn errors and signal terminations', async () => {
  const missing = createFakeSpawn([{ error: Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }) }]);
  const missingResult = await notifyDesktop(
    { title: 'T', body: 'B' },
    { platform: 'linux', spawn: missing.spawn },
  );
  assert.deepEqual(missingResult, { ok: false, kind: 'linux-notify-send', error: 'spawn powershell.exe ENOENT' });

  const signalled = createFakeSpawn([{ code: null, signal: 'SIGKILL' }]);
  const signalledResult = await notifyDesktop(
    { title: 'T', body: 'B' },
    { platform: 'darwin', spawn: signalled.spawn },
  );
  assert.deepEqual(signalledResult, { ok: false, kind: 'macos-notification', error: 'terminated by signal SIGKILL' });

  const broken = { spawn: () => ({}) };
  const brokenResult = await notifyDesktop({ title: 'T' }, { platform: 'linux', spawn: broken.spawn });
  assert.equal(brokenResult.ok, false);
  assert.equal(brokenResult.kind, 'linux-notify-send');
  assert.equal(brokenResult.error, 'spawn() did not return a child process');
});

test('notifyDesktop short-circuits unsupported platforms without spawning', async () => {
  const fake = createFakeSpawn([{ code: 0 }]);

  const result = await notifyDesktop({ title: 'T' }, { platform: 'freebsd', spawn: fake.spawn });

  assert.deepEqual(result, { ok: false, kind: 'unsupported', error: 'unsupported platform: freebsd' });
  assert.equal(fake.calls.length, 0);
});

test('notifyDesktop isolates a throwing onError hook', async () => {
  const fake = createFakeSpawn([{ code: 9 }]);

  const result = await notifyDesktop(
    { title: 'T' },
    {
      platform: 'linux',
      spawn: fake.spawn,
      onError: () => {
        throw new Error('hook exploded');
      },
    },
  );

  assert.deepEqual(result, { ok: false, kind: 'linux-notify-send', error: 'exited with code 9' });
});

test('notifyDesktop passes the injection payload through untouched argv entries', async () => {
  const payload = "' ; Remove-Item -Recurse C:\\ -Force ; '";
  const fake = createFakeSpawn([{ code: 0 }]);

  const result = await notifyDesktop({ title: payload, body: 'b' }, { platform: 'win32', spawn: fake.spawn });

  assert.deepEqual(result, { ok: true, kind: 'windows-toast' });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].args.length, 6);
  const script = fake.calls[0].args[5];
  assert.equal(script.includes("' ; Remove-Item"), false);
  assert.ok(extractPowerShellLiterals(script).some((literal) => literal.includes(escapeXml(payload))));
});
