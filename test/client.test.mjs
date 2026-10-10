/**
 * Node-side tests for the browser half (`lib/client.js`).
 *
 * There is no DOM, no React and no jsdom here. The module is evaluated with a fake
 * global `window` whose `__ModuleLoader__.load` records the call, and the factory is
 * handed a fake `require` that returns a minimal React: `createElement` produces a
 * plain `{ type, props, children }` object, the hooks are backed by a flat slot array
 * indexed by call order, and effects are collected instead of run so a test decides
 * when to flush them.
 *
 * `flatten` then renders the presentational helpers (`Card`, `Field`, `Switch`, …) the
 * way React would. Those helpers hold no state, so expanding them is enough to reach
 * the real host elements — which is what makes `role="switch"`, `aria-checked`,
 * `disabled` and input values assertable without a browser.
 *
 * The second half of the suite covers the **config generator**, the panel that renders
 * when the settings service offers no live namespace (the expected case for a
 * dependency-free plugin). It parses the generated YAML back with a strict reader for
 * the emitted subset — `parseYamlBlock`, which accepts only constructs the emitter can
 * produce and resolves plain scalars the way a real YAML reader does — and then pushes
 * that through the host's own `normalizeConfig`, so "the preview round-trips" is
 * checked against the code that will actually read the pasted file.
 *
 * What this cannot prove is real React reconciliation or real pixels. It proves the
 * package loads the way the Harness loads it, that the registration matches the slot
 * contract, that discovery degrades to the generator instead of throwing, that the
 * generated block means the same thing after a YAML round-trip, and that the config the
 * form produces is exactly what the host expects.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { DEFAULTS as HOST_DEFAULTS, normalizeConfig } from '../lib/config.js';
import { detectTargetType as hostDetectTargetType } from '../lib/payloads.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.join(here, '..', 'lib', 'client.js');
const SOURCE = readFileSync(CLIENT_PATH, 'utf8');

/** The source with comments removed, so prose cannot trip a source-level guard. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** The complete default config the host would report for an empty row. */
const HOST_EFFECTIVE_DEFAULTS = normalizeConfig({});

/** The 13 theme tokens the client half is allowed to read. */
const ALLOWED_TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
];

/* ------------------------------------------------------------------ *
 * fake React
 * ------------------------------------------------------------------ */

function sameDeps(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

/** Minimal hook runtime: one flat slot array, effects collected rather than run. */
function createHookRuntime() {
  const slots = [];
  let cursor = 0;
  let scheduled = [];

  const api = {
    createElement(type, props, ...children) {
      return { type, props: props ? { ...props } : {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next;
      }];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const existing = slots[index];
      if (existing && sameDeps(existing.deps, deps)) return;
      slots[index] = { kind: 'effect', deps: Array.isArray(deps) ? [...deps] : deps, effect };
    },
    useMemo(factory, deps) {
      const index = cursor++;
      const existing = slots[index];
      if (!existing || !sameDeps(existing.deps, deps)) {
        slots[index] = { kind: 'memo', deps: Array.isArray(deps) ? [...deps] : deps, value: factory() };
      }
      return slots[index].value;
    },
    useCallback(fn, deps) {
      return api.useMemo(() => fn, deps);
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
  };

  return {
    api,
    /**
     * Start a fresh render pass.
     *
     * Effects that were scheduled but never flushed stay pending: a render only
     * schedules work, exactly like React, so rendering out of band cannot lose an
     * effect that a test still expects to run.
     */
    begin() {
      cursor = 0;
      scheduled = [];
      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        if (slot && slot.kind === 'effect' && slot.effect) scheduled.push(index);
      }
    },
    /** Run the effects collected during the current pass. */
    flush() {
      const pending = scheduled;
      scheduled = [];
      for (const index of pending) {
        const slot = slots[index];
        if (!slot || slot.kind !== 'effect' || !slot.effect) continue;
        const effect = slot.effect;
        slot.effect = null;
        effect();
      }
    },
  };
}

/** Evaluate the module exactly as the Harness would: `window.__ModuleLoader__.load`. */
function createModule() {
  const runtime = createHookRuntime();
  const calls = [];
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        calls.push(spec);
      },
    },
  };

  new Function('window', SOURCE)(fakeWindow); // eslint-disable-line no-new-func

  const requireFn = (id) => {
    if (id === 'react') return runtime.api;
    throw new Error(`unexpected require: ${id}`);
  };

  return { calls, runtime, requireFn, spec: calls[0], exports: calls[0].factory(requireFn) };
}

/** Let every pending promise chain settle. */
async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Expand function components into host elements.
 *
 * Only the presentational helpers are expanded; the stateful page component is
 * invoked by `paint` itself, because it owns the hook slots. None of the helpers this
 * walks into call hooks, so sharing the slot array with the page is safe.
 */
function flatten(node, depth = 0) {
  if (Array.isArray(node)) return node.flatMap((child) => flatten(child, depth));
  if (!node || typeof node !== 'object') return [node];
  if (typeof node.type === 'function' && depth < 40) {
    return flatten(node.type({ ...(node.props || {}), children: node.children }), depth + 1);
  }
  return [{ ...node, children: flatten(node.children, depth) }];
}

/** Render, run the collected effects, settle, and render again — a few times. */
async function paint(runtime, Component, passes = 3) {
  let tree = null;
  for (let pass = 0; pass < passes; pass += 1) {
    runtime.begin();
    tree = flatten(Component());
    runtime.flush();
    await flushAsync();
  }
  return tree;
}

/* ------------------------------------------------------------------ *
 * tree helpers
 * ------------------------------------------------------------------ */

function elements(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if (node && typeof node === 'object') {
    out.push(node);
    elements(node.children, out);
  }
  return out;
}

function strings(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) strings(child, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const props = node.props || {};
    for (const key of ['aria-label', 'placeholder']) {
      if (typeof props[key] === 'string' && props[key]) out.push(props[key]);
    }
    if (typeof props.value === 'string' && props.value) out.push(props.value);
    strings(node.children, out);
  }
  return out;
}

function textOf(node) {
  return strings(node.children || []).join('');
}

/** Only real buttons: a `<option>` or a `<span>` can carry the same text. */
function findButton(tree, label) {
  return elements(tree).find((el) => el.type === 'button' && textOf(el) === label) || null;
}

function findSwitch(tree, label) {
  return elements(tree).find((el) => (el.props || {}).role === 'switch' && el.props['aria-label'] === label) || null;
}

function findInput(tree, label) {
  return elements(tree).find((el) => el.type === 'input' && (el.props || {})['aria-label'] === label) || null;
}

function findSelect(tree, label) {
  return elements(tree).find((el) => el.type === 'select' && (el.props || {})['aria-label'] === label) || null;
}

/** Type into a controlled input the way the DOM does: through an event. */
function typeInto(element, value) {
  assert.ok(element, 'the input exists');
  element.props.onChange({ target: { value: String(value) } });
}

/** Pick a `<select>` option the way the DOM does: through an event. */
function choose(element, value) {
  assert.ok(element, 'the select exists');
  element.props.onChange({ target: { value } });
}

/** The text of the n-th `<pre>` block, which is where a generated snippet is rendered. */
function preText(tree, index = 0) {
  const blocks = elements(tree).filter((el) => el.type === 'pre');
  return blocks[index] ? textOf(blocks[index]) : '';
}

/** The text of the clipboard fallback textarea, or `null` when it is not rendered. */
function textareaValue(tree) {
  const area = elements(tree).find((el) => el.type === 'textarea');
  return area ? area.props.value : null;
}

/**
 * Run `body` with the browser language pinned, then restore the global.
 *
 * The module reads `navigator` at call time, so this is the only way to make the
 * "config not loaded yet" language deterministic on a machine whose own language is
 * whatever it is. Node exposes `navigator` as a configurable own property (and older
 * versions have none at all), so a descriptor save/restore covers both.
 */
function withNavigatorLanguage(language, body) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true, writable: true });
  try {
    return body();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
}

/**
 * The same, for an `await`-ing body: the pin has to stay in place until the body
 * settles, because a click handler runs between two of its awaits.
 */
async function withNavigator(language, clipboard, body) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const value = clipboard === undefined ? { language } : { language, clipboard };
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  try {
    return await body();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
}

/* ------------------------------------------------------------------ *
 * a strict reader for the emitted YAML subset
 * ------------------------------------------------------------------ */

/**
 * Parse the block YAML the emitter writes: nested maps, sequences of maps and scalars,
 * `[]` / `{}`, plain scalars, `''`, and single- or double-quoted strings.
 *
 * This is deliberately a reader *for the emitted subset* rather than a YAML
 * implementation: it accepts nothing the emitter cannot produce and throws on anything
 * else, so it cannot paper over a formatting bug (an unquoted `a: b` value, a stray
 * tab, a wrong indent, a comment). Plain scalars resolve the way a real YAML reader
 * resolves them — `true`/`false` become booleans, digits become numbers — which is what
 * makes the round-trip meaningful: a chat id emitted unquoted would come back as `7`
 * and fail the comparison.
 */
function parseYamlBlock(source) {
  const lines = [];
  String(source).split('\n').forEach((line, index) => {
    if (line.includes('\t')) throw new Error(`yaml: tab character on line ${index + 1}`);
    const indent = line.length - line.replace(/^ */, '').length;
    const body = line.slice(indent);
    if (body === '') return;
    if (body.startsWith('#')) throw new Error(`yaml: comments are not emitted (line ${index + 1})`);
    lines.push({ indent, body, line: index + 1 });
  });

  let position = 0;
  const current = () => lines[position];

  function scalar(source, lineNumber) {
    const value = source.trim();
    if (value === "''") return '';
    if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"')) throw new Error(`yaml: unterminated double quote on line ${lineNumber}`);
      const inner = value.slice(1, -1);
      let out = '';
      for (let i = 0; i < inner.length; i += 1) {
        const char = inner[i];
        if (char !== '\\') { out += char; continue; }
        const next = inner[i + 1];
        i += 1;
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else if (next === '"') out += '"';
        else if (next === '\\') out += '\\';
        else if (next === 'u') {
          const hex = inner.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`yaml: bad \\u escape on line ${lineNumber}`);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else throw new Error(`yaml: unknown escape \\${next} on line ${lineNumber}`);
      }
      return out;
    }
    if (value.startsWith("'")) {
      if (value.length < 2 || !value.endsWith("'")) throw new Error(`yaml: unterminated single quote on line ${lineNumber}`);
      return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value === '[]') return [];
    if (value === '{}') return {};
    if (value === 'null' || value === '~') return null;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^-?\d+$/.test(value)) return Number(value);
    if (/^-?\d*\.\d+$/.test(value)) return Number(value);
    if (/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(value)) return Number(value);
    if (value === '') throw new Error(`yaml: missing value on line ${lineNumber}`);
    return value;
  }

  /** Split `key: value` / `key:`; `null` when the text is not a mapping entry. */
  function splitEntry(body, lineNumber) {
    if (body.startsWith('"') || body.startsWith("'")) {
      const quote = body[0];
      let i = 1;
      while (i < body.length) {
        if (quote === "'" && body[i] === "'" && body[i + 1] === "'") { i += 2; continue; }
        if (quote === '"' && body[i] === '\\') { i += 2; continue; }
        if (body[i] === quote) break;
        i += 1;
      }
      if (body[i] !== quote) throw new Error(`yaml: unterminated key on line ${lineNumber}`);
      if (body[i + 1] !== ':') throw new Error(`yaml: quoted key without ':' on line ${lineNumber}`);
      return { key: scalar(body.slice(0, i + 1), lineNumber), rest: body.slice(i + 2).trim() };
    }
    const at = body.indexOf(': ');
    if (at >= 0) return { key: body.slice(0, at), rest: body.slice(at + 1).trim() };
    if (body.endsWith(':')) return { key: body.slice(0, -1), rest: '' };
    return null;
  }

  function parseMap(indent) {
    const out = {};
    while (position < lines.length) {
      const line = current();
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`yaml: unexpected indent on line ${line.line}`);
      if (line.body === '-' || line.body.startsWith('- ')) throw new Error(`yaml: sequence item inside a map on line ${line.line}`);
      const entry = splitEntry(line.body, line.line);
      if (!entry) throw new Error(`yaml: not a mapping entry on line ${line.line}: ${JSON.stringify(line.body)}`);
      if (entry.key === '') throw new Error(`yaml: empty key on line ${line.line}`);
      position += 1;
      if (entry.rest !== '') { out[entry.key] = scalar(entry.rest, line.line); continue; }
      const next = current();
      out[entry.key] = next && next.indent > indent ? parseBlock(next.indent) : null;
    }
    return out;
  }

  function parseSequence(indent) {
    const out = [];
    while (position < lines.length) {
      const line = current();
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`yaml: unexpected indent on line ${line.line}`);
      if (line.body !== '-' && !line.body.startsWith('- ')) break;
      const rest = line.body.slice(1).trimStart();
      if (rest === '') {
        position += 1;
        const next = current();
        out.push(next && next.indent > indent ? parseBlock(next.indent) : null);
        continue;
      }
      // `- key: value` opens a map whose continuation lines line up under the key.
      const itemIndent = line.indent + (line.body.length - rest.length);
      lines[position] = { indent: itemIndent, body: rest, line: line.line };
      if (splitEntry(rest, line.line)) out.push(parseMap(itemIndent));
      else { position += 1; out.push(scalar(rest, line.line)); }
    }
    return out;
  }

  function parseBlock(indent) {
    const line = current();
    if (!line) return null;
    return line.body === '-' || line.body.startsWith('- ') ? parseSequence(indent) : parseMap(indent);
  }

  if (!lines.length) throw new Error('yaml: empty document');
  const value = parseBlock(lines[0].indent);
  if (position !== lines.length) throw new Error(`yaml: unconsumed content at line ${lines[position].line}`);
  return value;
}

/* ------------------------------------------------------------------ *
 * fake host context
 * ------------------------------------------------------------------ */

/** A `NamespaceView` carrying a complete config value. */
function namespace(value, revision = 3, ns = 'include:notify-hook') {
  return { ns, revision, value, applies: 'live', secrets: [], autoGenerate: [] };
}

/** Minimal official-locale surface used by client registration and rendering tests. */
function createLocaleHarness(initialLocale) {
  const dictionaries = new Map();
  let locale = typeof initialLocale === 'string' ? initialLocale : 'en';
  return {
    service: {
      register(ns, value) {
        dictionaries.set(ns, value);
        return () => dictionaries.delete(ns);
      },
      bind(ns) {
        return (key) => dictionaries.get(ns)?.[locale]?.[key] ?? key;
      },
      getLocale() {
        return locale;
      },
    },
    setLocale(next) {
      locale = next;
    },
  };
}

const remoteOk = (value) => ({ ok: true, value });
const remoteFail = (message, code = 'test/failure') => ({
  ok: false,
  error: { code, message },
});

/**
 * Register the page against a fake context.
 *
 * `update` mirrors the documented host contract: the patch is merged into the live
 * value and the row comes back with a new revision.
 */
function mount(options = {}) {
  const harness = createModule();
  const registrations = [];
  const injections = [];
  const updates = [];
  const localeHarness = createLocaleHarness(options.dshLocale);
  const clientDisposers = [];
  let value = JSON.parse(JSON.stringify(options.value || HOST_DEFAULTS));
  let revision = typeof options.revision === 'number' ? options.revision : 3;

  const describe = options.describe || (async () => remoteOk({
    writable: true,
    hasDocument: true,
    namespaces: options.namespaces || [namespace(JSON.parse(JSON.stringify(value)), revision)],
  }));

  const update = options.update || (async (ns, patch, expectedRevision) => {
    updates.push({ ns, patch, revision: expectedRevision });
    value = normalizeConfig({ ...value, ...patch });
    revision = (typeof expectedRevision === 'number' ? expectedRevision : revision) + 1;
    return remoteOk(namespace(JSON.parse(JSON.stringify(value)), revision, ns));
  });

  const ctx = {
    effect(factory) {
      const disposer = factory();
      if (typeof disposer === 'function') clientDisposers.push(disposer);
    },
    locale: localeHarness.service,
    slots: {
      inject(name, register) {
        injections.push(name);
        return register();
      },
      register(entryOptions, component) {
        registrations.push({ options: entryOptions, component });
        return () => {};
      },
    },
    remote: { settings: { describe, update } },
  };

  harness.exports.apply(ctx);
  const entry = registrations[0] || { options: {}, component: null };
  return {
    ...harness,
    ctx,
    registrations,
    injections,
    updates,
    options: entry.options,
    Component: entry.component,
    test: harness.exports.__test,
    setDshLocale(locale) {
      localeHarness.setLocale(locale);
    },
    disposeClient() {
      for (const disposer of clientDisposers.splice(0)) disposer();
    },
  };
}

/* ================================================================== *
 * packaging
 * ================================================================== */

test('the module loader is called once, with the package name as id', () => {
  const calls = [];
  const fakeWindow = { __ModuleLoader__: { load(spec) { calls.push(spec); } } };
  new Function('window', SOURCE)(fakeWindow); // eslint-disable-line no-new-func
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'dsh-notification-hook');
  assert.equal(typeof calls[0].factory, 'function');
});

test('the normal settings page hides developer diagnostics', async () => {
  const harness = mount();
  const all = strings(await paint(harness.runtime, harness.Component));
  for (const fragment of ['version: 0.3.0', 'describe: ok', 'writable: true', 'namespaces:', 'ids matched:', 'value types:']) {
    assert.equal(all.some((line) => line.includes(fragment)), false, `${fragment} stays out of the normal footer`);
  }
});

test('the factory is side-effect free and requires nothing but react', () => {
  const harness = createModule();
  assert.deepEqual(harness.exports.inject.slice().sort(), ['locale', 'remote', 'remote.settings', 'slots']);
  assert.equal(typeof harness.exports.apply, 'function');
  const requires = [...CODE.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]);
  assert.deepEqual(requires, ['react']);
});

test('the source stays plain browser JavaScript: no ESM, no JSX, no document, no third party', () => {
  assert.equal(/^\s*import\s/m.test(CODE), false, 'no import statements');
  assert.equal(/^\s*export\s/m.test(CODE), false, 'no export statements');
  assert.equal(/\bfrom\s+['"]/.test(CODE), false, 'no module specifiers');
  assert.equal(/@deepseek-ai\//.test(CODE), false, 'no harness package imports');
  assert.equal(/document\./.test(CODE), false, 'no document access at all');
  assert.equal(/jsx/i.test(CODE), false, 'no JSX');
});

test('every colour goes through one of the thirteen theme tokens', () => {
  const used = new Set([...CODE.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((match) => match[1]));
  assert.ok(used.size > 0, 'the module uses theme tokens');
  for (const token of used) {
    assert.ok(ALLOWED_TOKENS.includes(token), `unexpected theme token: ${token}`);
  }
  assert.equal(/rgba?\(|hsla?\(/.test(CODE), false, 'no rgb()/hsl() literals');
  assert.equal(/['"]#[0-9a-fA-F]{3}/.test(CODE), false, 'no hex colour literals');
});

/* ================================================================== *
 * strings
 * ================================================================== */

test('English and Chinese carry exactly the same keys, all filled in', () => {
  const { STRINGS } = createModule().exports.__test;
  const en = Object.keys(STRINGS.en).sort();
  const zh = Object.keys(STRINGS.zh).sort();
  assert.deepEqual(zh, en);
  for (const key of en) {
    assert.equal(typeof STRINGS.en[key], 'string', `en.${key} is a string`);
    assert.equal(typeof STRINGS.zh[key], 'string', `zh.${key} is a string`);
    assert.ok(STRINGS.en[key].trim().length > 0, `en.${key} is not empty`);
    assert.ok(STRINGS.zh[key].trim().length > 0, `zh.${key} is not empty`);
  }
  // Product names are intentionally identical; prose must not be.
  for (const key of ['title', 'footerSave', 'footerSendTest', 'secEvents', 'statusSaved', 'genTitle', 'genNote', 'genPasteWhere', 'evCompleted', 'presetBalanced', 'urlMissing', 'targetAdd']) {
    assert.notEqual(STRINGS.zh[key], STRINGS.en[key], `zh.${key} is actually translated`);
  }
});

test('the client copy of the defaults still matches lib/config.js', () => {
  const { EDITABLE_DEFAULTS } = createModule().exports.__test;
  for (const [key, value] of Object.entries(EDITABLE_DEFAULTS)) {
    assert.ok(key in HOST_EFFECTIVE_DEFAULTS, `the host config still has ${key}`);
    if (key === 'events' || key === 'desktop') {
      for (const [inner, innerValue] of Object.entries(value)) {
        assert.equal(innerValue, HOST_EFFECTIVE_DEFAULTS[key][inner], `${key}.${inner} matches the host default`);
      }
      continue;
    }
    assert.deepEqual(value, HOST_EFFECTIVE_DEFAULTS[key], `${key} matches the host default`);
  }
  // The reverse direction, minus what this form deliberately does not edit.
  const notEdited = new Set(['logLevel', 'appId', 'timeoutMs']);
  for (const key of Object.keys(HOST_EFFECTIVE_DEFAULTS)) {
    if (notEdited.has(key) || key in EDITABLE_DEFAULTS) continue;
    assert.ok(key in EDITABLE_DEFAULTS, `${key} should be editable or explicitly excluded`);
  }
});

test('a mixed-case locale or logLevel is not silently rewritten by the panel', () => {
  // The panel shows whatever the host reports as the live value, so a case-sensitive
  // host test plus a lower-casing client produced a lie: `logLevel: SILENT` displayed
  // as `silent` while the host actually ran at `info`, and the next Save wrote the
  // displayed value back. Both halves must agree on the value the user typed.
  const { draftFromValue, patchOf } = createModule().exports.__test;
  const cases = [
    ['logLevel', 'SILENT', 'silent'],
    ['logLevel', 'Info', 'info'],
    ['logLevel', '  WARN  ', 'warn'],
    ['locale', 'ZH', 'zh'],
    ['locale', 'EN', 'en'],
    ['locale', ' Auto ', 'auto'],
  ];
  for (const [key, raw, expected] of cases) {
    const effective = normalizeConfig({ [key]: raw });
    assert.equal(effective[key], expected, `${key} ${JSON.stringify(raw)}: the host accepts the typed case`);
    const draft = draftFromValue(effective);
    assert.equal(draft[key], expected, `${key}: the panel shows the value the host will run`);
    assert.equal(patchOf(draft, null)[key], expected, `${key}: Save writes that same value, not a rewrite`);
  }

  // A genuinely invalid value still falls back on both sides, in the same direction.
  assert.equal(normalizeConfig({ logLevel: 'loud', locale: 'de-DE' }).logLevel, 'info');
  assert.equal(normalizeConfig({ locale: 'de-DE' }).locale, 'auto');
  assert.equal(draftFromValue(normalizeConfig({ logLevel: 'loud' })).logLevel, 'info');
  assert.equal(draftFromValue(normalizeConfig({ locale: 'de-DE' })).locale, 'auto');
  assert.equal(patchOf(draftFromValue(normalizeConfig({ logLevel: 'loud' })), null).logLevel, 'info');

  // The panel's own coercion of a *raw* value matches the host's, so a row that never
  // travelled through the host cannot be displayed as something else either.
  for (const [key, raw] of [['logLevel', 'SILENT'], ['locale', 'ZH'], ['locale', 'EN']]) {
    assert.equal(draftFromValue({ [key]: raw })[key], normalizeConfig({ [key]: raw })[key], `${key} ${raw}`);
  }
});

/* ================================================================== *
 * registration
 * ================================================================== */

test('apply registers exactly one settings.plugins.tab entry', () => {
  const harness = mount();
  assert.deepEqual(harness.injections, ['settings.plugins.tab']);
  assert.equal(harness.registrations.length, 1);
  assert.equal(harness.options.name, 'settings.plugins.tab');
  assert.equal(harness.options.id, 'notify-hook');
  assert.equal(typeof harness.options.order, 'number');
  assert.equal(typeof harness.options.label, 'function');
  assert.equal(typeof harness.Component, 'function');
  const label = harness.options.label();
  assert.ok([harness.test.STRINGS.en.tabLabel, harness.test.STRINGS.zh.tabLabel].includes(label));
});

test('apply survives a context with no slots service at all', () => {
  const harness = createModule();
  assert.doesNotThrow(() => harness.exports.apply({}));
  assert.doesNotThrow(() => harness.exports.apply(undefined));
});

test('a registration that throws is reported at error level, not swallowed', () => {
  // `apply` must not throw — a throwing `apply` fails the whole plugin row — but a
  // registration conflict means the tab never appears, and nothing in the UI says so.
  // The console is the only place left, so the failure has to be loud and named.
  const harness = createModule();
  const errors = [];
  const warnings = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (message, error) => { errors.push({ message, error }); };
  console.warn = (message, error) => { warnings.push({ message, error }); };
  const boom = new Error('an entry with id notify-hook already exists');
  const locale = createLocaleHarness('en');
  try {
    assert.doesNotThrow(() => harness.exports.apply({
      effect(factory) { return factory(); },
      locale: locale.service,
      slots: {
        inject(name, register) { return register(); },
        register() { throw boom; },
      },
      remote: {},
    }));
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 0, 'a missing tab is not a warning-level event');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, boom, 'the cause is passed through for the console to expand');
  assert.ok(errors[0].message.includes('settings.plugins.tab'), 'the slot key is named');
  assert.ok(errors[0].message.includes('dsh-notification-hook'), 'the bundle is named');
  assert.ok(errors[0].message.includes('notify-hook'), 'the entry id is named');
  assert.ok(errors[0].message.includes('[dsh-notification-hook]'), 'and it goes through the module log sink');
});

/* ================================================================== *
 * rendering
 * ================================================================== */

test('wrapped describe response reveals the live namespace', async () => {
  const harness = mount();
  const t = harness.test.STRINGS.en;
  const tree = await paint(harness.runtime, harness.Component);
  const all = strings(tree);

  assert.ok(all.includes(t.title), 'the localized title is rendered');
  assert.ok(all.includes(t.footerSave), 'the save button is rendered');
  assert.ok(all.includes(t.footerSendTest));
  assert.equal(all.includes(t.genTitle), false, 'the recovery generator stays hidden');
  assert.ok(all.includes(t.presetBalanced), 'the default config reads as the balanced preset');
  assert.ok(all.includes(t.presetBalancedHint));

  // Seeded from the live value, not from the client defaults.
  assert.equal(findInput(tree, t.fieldMinDuration).props.value, String(HOST_DEFAULTS.minDurationMs));
  assert.equal(findInput(tree, t.fieldAwaitingDelay).props.value, String(HOST_DEFAULTS.awaitingInputDelayMs));
  assert.equal(findSelect(tree, t.fieldLogLevel).props.value, 'info');

  // Nothing has been edited, so saving is a no-op and stays disabled.
  assert.equal(findButton(tree, t.footerSave).props.disabled, true);
  assert.equal(findButton(tree, t.footerSendTest).props.disabled, false);

  // Every switch reflects the config value; cancelled is off by default.
  assert.equal(findSwitch(tree, t.evCompleted).props['aria-checked'], 'true');
  assert.equal(findSwitch(tree, t.evCancelled).props['aria-checked'], 'false');
  assert.equal(findSwitch(tree, t.desktopEnabled).props['aria-checked'], 'true');
  assert.equal(findSwitch(tree, t.desktopSound).props['aria-checked'], 'false');
  assert.equal(findSwitch(tree, t.masterLabel).props['aria-checked'], 'true');
});

test('core events stay prominent and secondary events move under Advanced', async () => {
  const harness = mount({ value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' } });
  const t = harness.test.STRINGS.en;
  const tree = await paint(harness.runtime, harness.Component);
  const all = strings(tree);
  const advanced = all.indexOf(t.secAdvanced);

  assert.ok(advanced >= 0, 'the Advanced card is rendered');
  for (const label of [t.evCompleted, t.evFailed, t.evAwaitingInput]) {
    assert.ok(all.indexOf(label) >= 0 && all.indexOf(label) < advanced, `${label} remains a primary control`);
  }
  for (const label of [t.evAttention, t.evCancelled]) {
    assert.ok(all.indexOf(label) > advanced, `${label} moves under Advanced`);
  }
  for (const label of [t.evCompleted, t.evFailed, t.evAwaitingInput, t.evAttention, t.evCancelled]) {
    assert.ok(findSwitch(tree, label), `${label} remains stored and editable`);
  }
});

test('the master switch is a real switch: Enter and Space both toggle it', async () => {
  const harness = mount({ value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' } });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);
  assert.equal(findSwitch(tree, t.masterLabel).props['aria-checked'], 'true');

  let prevented = 0;
  harness.runtime.begin();
  const master = findSwitch(tree, t.masterLabel);
  assert.equal(typeof master.props.onKeyDown, 'function', 'the switch handles keys');
  master.props.onKeyDown({ key: ' ', preventDefault: () => { prevented += 1; } });
  tree = await paint(harness.runtime, harness.Component);
  assert.equal(prevented, 1, 'Space does not scroll the page');
  assert.equal(findSwitch(tree, t.masterLabel).props['aria-checked'], 'false');

  harness.runtime.begin();
  findSwitch(tree, t.masterLabel).props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented += 1; } });
  tree = await paint(harness.runtime, harness.Component);
  assert.equal(findSwitch(tree, t.masterLabel).props['aria-checked'], 'true');

  // An unrelated key is ignored.
  harness.runtime.begin();
  findSwitch(tree, t.masterLabel).props.onKeyDown({ key: 'a', preventDefault: () => { prevented += 1; } });
  tree = await paint(harness.runtime, harness.Component);
  assert.equal(findSwitch(tree, t.masterLabel).props['aria-checked'], 'true');

  // Flipping it off is a change worth saving.
  harness.runtime.begin();
  findSwitch(tree, t.masterLabel).props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  assert.equal(findButton(tree, t.footerSave).props.disabled, false);
  assert.ok(strings(tree).includes(t.statusDisabled), 'the status line follows the master switch');
});

test('the DSH locale alone drives both the cached tab label and the panel body', async () => {
  // A stored legacy plugin locale must no longer create a second language preference.
  // The DSH slot owner invalidates cached labels on an official locale revision, so the
  // registration has to translate through ctx.locale rather than through draft state.
  const harness = mount({
    dshLocale: 'en',
    value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'zh' },
  });
  let tree = await paint(harness.runtime, harness.Component);
  assert.equal(harness.options.label(), 'Notifications');
  assert.ok(strings(tree).includes('Notifications & webhooks'));
  assert.equal(strings(tree).includes('通知与推送'), false);
  assert.equal(strings(tree).includes('Notification language'), false, 'there is no plugin-specific language control');
  assert.equal(strings(tree).includes('通知语言'), false, 'there is no hidden Chinese copy of that control');

  harness.setDshLocale('zh');
  tree = await paint(harness.runtime, harness.Component);
  assert.equal(harness.options.label(), '任务提醒');
  assert.ok(strings(tree).includes('通知与推送'));
  assert.equal(strings(tree).includes('Notifications & webhooks'), false);
});

/* ================================================================== *
 * discovery
 * ================================================================== */

test('a matching namespace id with no usable value opens the generator instead of inventing a config', async () => {
  // `SettingsNamespaceView.value` is typed `JsonValue`, so `null` is a legal answer for
  // "this row has no live configuration". Matching by id alone used to count as a
  // discovery, which rendered an editable form seeded from this client's own defaults:
  // Save (and the test button, which writes the same patch) then wrote those defaults
  // over the user's row. No usable value must mean no write surface at all — the
  // generator, which hands over YAML rather than writing anything.
  const { discoverView, NS_IDS, STRINGS } = createModule().exports.__test;
  const t = STRINGS.en;
  const NS_EXACT = NS_IDS[1];

  // The id the host actually publishes is the row's PATCH id, `notify-hook` — not the loader
  // tree id. Discovery must accept the bare id; matching only on `include:notify-hook` is what
  // made a working live namespace fall through to the generator in the real app.
  assert.ok(NS_IDS.includes('notify-hook'), 'the bare patch id is a primary namespace key');
  const liveValue = { awaitingInputDelayMs: 2500, webhooks: [], desktop: {} };
  assert.deepEqual(
    discoverView([{ ns: 'notify-hook', revision: 7, value: liveValue }]),
    { ns: 'notify-hook', revision: 7, value: liveValue },
    'the bare patch id must be discovered',
  );
  assert.deepEqual(
    discoverView([{ ns: 'include:notify-hook', revision: 7, value: liveValue }]).ns,
    'include:notify-hook',
    'the loader tree id stays accepted',
  );
  assert.deepEqual(
    discoverView([{ ns: 'profile:notify-hook', revision: 7, value: liveValue }]).ns,
    'profile:notify-hook',
    'any id whose last segment is the row id is accepted',
  );

  for (const value of [null, 'x', 42, [], true, undefined]) {
    const label = `value ${JSON.stringify(value) ?? String(value)}`;
    assert.equal(discoverView([{ ns: 'notify-hook', revision: 4, value }]), null, `${label}: not a discovery`);
    assert.equal(discoverView([{ ns: NS_EXACT, revision: 4, value }]), null, `${label}: not a discovery`);

    const harness = mount({ namespaces: [{ ns: 'notify-hook', revision: 4, value }] });
    const tree = await paint(harness.runtime, harness.Component);
    const all = strings(tree);
    assert.ok(all.includes(t.genTitle), `${label}: the generator is rendered`);
    assert.equal(all.includes(t.footerSave), false, `${label}: no Save button`);
    assert.equal(findButton(tree, t.footerSendTest), null, `${label}: the test button writes the draft too`);
    assert.equal(harness.registrations.length, 1, `${label}: the tab itself is still registered`);
    assert.equal(harness.updates.length, 0, `${label}: and nothing was written`);
  }

  // The suffix path has the same rule, and a later usable candidate still wins.
  assert.equal(discoverView([{ ns: 'other:notify-hook', revision: 1, value: null }]), null);
  const marker = { ns: 'weird:thing', revision: 2, value: { awaitingInputDelayMs: 1, webhooks: [], desktop: {} } };
  assert.equal(discoverView([{ ns: NS_EXACT, revision: 1, value: null }, marker]), marker);
});

test('a matching namespace id with an empty object value still renders the form', async () => {
  // `{}` *is* a plain object, so the id paths accept it: only the shape-based path also
  // requires the marker keys. This pins the boundary of the rule above, so a fix cannot
  // quietly start rejecting a real (if empty) value.
  const { EDITABLE_DEFAULTS, STRINGS } = createModule().exports.__test;
  const harness = mount({ namespaces: [{ ns: 'include:notify-hook', revision: 5, value: {} }] });
  const t = STRINGS.en;
  const tree = await paint(harness.runtime, harness.Component);
  const all = strings(tree);
  assert.ok(all.includes(t.title), 'the form is rendered');
  assert.equal(all.includes(t.genTitle), false, 'not the config generator');
  assert.equal(
    findInput(tree, t.fieldMinDuration).props.value,
    String(EDITABLE_DEFAULTS.minDurationMs),
    'the form is seeded from the client defaults, as an empty live value implies',
  );
  assert.equal(findButton(tree, t.footerSave).props.disabled, true, 'nothing to save yet');
});

test('discovery falls back through the id suffix and the config shape', async () => {
  const cases = [
    { names: 'the exact namespace id', ns: 'include:notify-hook' },
    { names: 'a renamed row on the same suffix', ns: 'other:notify-hook' },
    { names: 'an unrelated id with the config shape', ns: 'weird:thing' },
  ];

  for (const item of cases) {
    const value = item.ns === 'weird:thing'
      ? { locale: 'en', awaitingInputDelayMs: 1, webhooks: [], desktop: {} }
      : { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' };
    const harness = mount({ namespaces: [namespace(value, 7, item.ns)] });
    const t = harness.test.STRINGS.en;
    const all = strings(await paint(harness.runtime, harness.Component));
    assert.ok(all.includes(t.title), `${item.names}: renders the form`);
    assert.ok(all.includes(t.footerSave), `${item.names}: renders the save button`);
    assert.equal(all.includes(t.genTitle), false, `${item.names}: no config generator`);
  }
});

test('the exact namespace wins over a later marker match', async () => {
  const harness = mount({
    namespaces: [
      namespace({ awaitingInputDelayMs: 1, webhooks: [], desktop: {}, minDurationMs: 1111 }, 1, 'other:thing'),
      namespace({ ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en', minDurationMs: 4242 }, 2, 'include:notify-hook'),
    ],
  });
  const t = harness.test.STRINGS.en;
  const tree = await paint(harness.runtime, harness.Component);
  assert.equal(findInput(tree, t.fieldMinDuration).props.value, '4242');
});

test('no namespace at all renders the config generator and never throws', async () => {
  // The expected case for this plugin, so it must not read as a failure: the note says
  // why no live form exists and that the plugin keeps running, and everything the user
  // needs to configure it by hand is on the page.
  const harness = mount({ namespaces: [] });
  const t = harness.test.STRINGS.en;
  assert.doesNotThrow(() => harness.Component());
  const tree = await paint(harness.runtime, harness.Component);
  const all = strings(tree);

  assert.ok(all.includes(t.genTitle), 'the panel names the situation');
  assert.ok(all.includes(t.genNote), 'and explains it');
  assert.ok(all.includes(t.genPreviewTitle), 'a YAML preview is offered');
  assert.ok(all.includes(t.genPasteTitle), 'with paste instructions');
  assert.ok(all.includes(t.genPasteWhere));
  assert.ok(all.includes(t.genPasteReplaces), 'including why every field is printed');
  assert.ok(all.includes(t.genPasteReload));
  assert.ok(all.includes(t.genPasteLayer), 'and which layer the file is');
  assert.ok(all.includes(t.genPasteDefaults));
  assert.ok(all.some((line) => line.includes('cordis.patch.yml')), 'the file is named');
  assert.ok(all.some((line) => line.includes('- id: notify-hook')), 'the row is named');

  assert.equal(findButton(tree, t.footerSave), null, 'nothing here writes, so no Save');
  assert.equal(findButton(tree, t.footerSendTest), null, 'and no test button');
  assert.ok(findButton(tree, t.genCopy), 'each block offers Copy');
  assert.ok(findButton(tree, t.genPasteCopy), 'the row snippet has its own Copy');
  assert.ok(findButton(tree, t.genRetry), 'and discovery can be re-run');
  assert.equal(elements(tree).some((el) => el.type === 'textarea'), false, 'no manual fallback until a copy needs one');
});

test('the generator renders the exact YAML the emitter produces for the defaults', async () => {
  const harness = mount({ namespaces: [] });
  const t = harness.test.STRINGS.en;
  const { draftFromValue, previewYaml, pasteBlock } = harness.test;
  const tree = await paint(harness.runtime, harness.Component);

  const expected = previewYaml(draftFromValue(null), null);
  assert.equal(preText(tree), expected, 'the preview is the generated block, live');
  assert.equal(preText(tree, 1), pasteBlock(expected), 'and the paste block wraps it in the row');

  // The rendered block is the host's own default config, read back through YAML.
  assert.deepEqual(normalizeConfig(parseYamlBlock(preText(tree))), normalizeConfig({}));
  for (const line of ['enabled: true', 'locale: auto', 'minDurationMs: 10000', 'webhooks: []', "appId: ''"]) {
    assert.ok(preText(tree).includes(line), `the preview prints ${line}`);
  }
});

test('describe() rejecting renders the generator with the error and never throws', async () => {
  const harness = mount({ describe: async () => { throw new Error('gateway offline'); } });
  const t = harness.test.STRINGS.en;
  assert.doesNotThrow(() => harness.Component());
  const all = strings(await paint(harness.runtime, harness.Component));
  assert.ok(all.includes(t.genTitle));
  assert.ok(all.includes(t.genNote), 'the note still says the plugin keeps running');
  assert.ok(
    all.includes(t.genErrorPrefix.replace('{message}', 'gateway offline')),
    'the error is reported, because a describe() that throws is a real failure',
  );
  assert.ok(all.some((line) => line.includes('version: 0.3.0')), 'recovery retains the client version for support');
  assert.ok(all.some((line) => line.includes('describe threw: gateway offline')), 'recovery retains technical diagnostics');
  const details = elements(await paint(harness.runtime, harness.Component)).find((node) => node.type === 'details');
  assert.ok(details, 'recovery renders a technical diagnostics disclosure');
  assert.equal(details.props.open === true, false, 'technical diagnostics are collapsed by default');
  assert.ok(textOf(details).includes('describe threw: gateway offline'), 'the diagnostic text belongs to the disclosure');
  assert.equal(all.includes(t.footerSave), false, 'and still no Save button');
});

test('malformed Remote responses enter recovery without throwing', async () => {
  const malformed = [null, {}, { ok: true }, { ok: 'yes', value: { namespaces: [] } }];
  for (const response of malformed) {
    const harness = mount({ describe: async () => response });
    const t = harness.test.STRINGS.en;
    assert.doesNotThrow(() => harness.Component());
    const all = strings(await paint(harness.runtime, harness.Component));
    assert.ok(all.includes(t.genTitle), `recovery rendered for ${JSON.stringify(response)}`);
    assert.equal(all.includes(t.footerSave), false, 'malformed data never opens the write surface');
    assert.ok(all.some((line) => line.includes('settings.describe')), 'the failed operation is named');
  }
});

test('a missing settings service renders the generator instead of crashing', async () => {
  const harness = createModule();
  const registrations = [];
  const locale = createLocaleHarness();
  harness.exports.apply({
    effect(factory) { return factory(); },
    locale: locale.service,
    slots: {
      inject(name, register) { return register(); },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
    remote: {},
  });
  const tree = await paint(harness.runtime, registrations[0].component);
  const { STRINGS } = harness.exports.__test;
  const all = strings(tree);
  assert.ok(all.includes(STRINGS.en.genTitle));
  assert.ok(all.some((line) => line.includes('- id: notify-hook')), 'the snippet is offered even with no service at all');
});

test('a hostile namespace value still renders instead of throwing', async () => {
  const harness = mount({
    namespaces: [
      { ns: 'include:notify-hook', revision: 1, value: { events: null, desktop: 'nope', webhooks: 'nope', minDurationMs: 'abc' } },
      null,
      'not a view',
    ],
  });
  const all = strings(await paint(harness.runtime, harness.Component));
  const t = harness.test.STRINGS.en;
  assert.ok(all.includes(t.title), 'the form survives a malformed value');
  assert.equal(findInput(await paint(harness.runtime, harness.Component), t.fieldMinDuration).props.value, String(HOST_DEFAULTS.minDurationMs));
});

/* ================================================================== *
 * the generated config block
 * ================================================================== */

test('the generator offers exactly the live form controls, not a reduced form', async () => {
  // "Reuse the same section components" is only true if the two pages really render the
  // same controls, so this compares them field by field rather than trusting the code
  // shape: same inputs, same selects, same switches, same section titles. A second,
  // thinner form would show up here as a missing label.
  await withNavigator('en', undefined, async () => {
    const live = mount({ value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' } });
    const generator = mount({ namespaces: [] });
    const t = live.test.STRINGS.en;
    const liveTree = await paint(live.runtime, live.Component);
    const genTree = await paint(generator.runtime, generator.Component);

    const labels = (tree, type) => elements(tree)
      .filter((el) => el.type === type)
      .map((el) => (el.props || {})['aria-label'])
      .filter(Boolean)
      .sort();
    const switches = (tree) => elements(tree)
      .filter((el) => (el.props || {}).role === 'switch')
      .map((el) => el.props['aria-label'])
      .sort();

    assert.deepEqual(labels(genTree, 'input'), labels(liveTree, 'input'), 'the same inputs, with the same labels');
    assert.deepEqual(labels(genTree, 'select'), labels(liveTree, 'select'), 'the same selects');
    assert.deepEqual(switches(genTree), switches(liveTree), 'the same switches');
    assert.equal(switches(genTree).length, 11, 'master, 5 events, desktop ×2, subagents, deliveries, self-test');
    assert.deepEqual(labels(genTree, 'textarea'), [], 'and no extra field beyond the two snippets');

    for (const key of ['secVerbosity', 'secEvents', 'secDesktop', 'secTargets', 'secAdvanced']) {
      assert.ok(strings(genTree).includes(t[key]), `${key} is a section of the generator too`);
    }
    for (const key of ['targetAdd', 'quickAdd', 'typeTelegram', 'fieldTestOnActivate', 'fieldLogLevel']) {
      assert.ok(strings(genTree).includes(t[key]), `${key} is offered by the generator too`);
    }

    assert.ok(findButton(liveTree, t.footerSave), 'the live page saves');
    assert.ok(findButton(liveTree, t.footerSendTest), 'and can send a test');
    assert.equal(findButton(genTree, t.footerSave), null, 'the generator cannot save, and does not pretend to');
    assert.equal(findButton(genTree, t.footerSendTest), null, 'nor send a test');
  });
});

test('the preview regenerates as the controls change, in both blocks', async () => {
  const harness = mount({ namespaces: [] });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);
  assert.ok(preText(tree).startsWith('enabled: true'), 'the master switch leads the block');

  harness.runtime.begin();
  findSwitch(tree, t.masterLabel).props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  assert.ok(preText(tree).startsWith('enabled: false'), 'turning the plugin off is in the block at once');

  // A preset is the interesting case: it writes two fields at once.
  harness.runtime.begin();
  const detailed = elements(tree).find((el) => el.type === 'button' && (el.props || {}).role === 'radio' && textOf(el) === t.presetDetailed);
  assert.ok(detailed, 'the presets are offered');
  detailed.props.onClick();
  tree = await paint(harness.runtime, harness.Component);

  const preview = preText(tree);
  assert.ok(preview.includes('minDurationMs: 0'), 'the preset duration is in the block');
  assert.ok(preview.includes('cancelled: true'), 'so is the event it switched on');
  const effective = normalizeConfig(parseYamlBlock(preview));
  assert.equal(effective.events.cancelled, true);
  assert.equal(effective.minDurationMs, 0);
  assert.equal(effective.enabled, false, 'and the earlier switch is still there');
  assert.equal(preText(tree, 1), harness.test.pasteBlock(preview), 'both blocks stay in step');

  // Typing into a number field is reflected too, and an emptied field falls back.
  harness.runtime.begin();
  typeInto(findInput(tree, t.fieldAwaitingDelay), '');
  tree = await paint(harness.runtime, harness.Component);
  assert.equal(normalizeConfig(parseYamlBlock(preText(tree))).awaitingInputDelayMs, HOST_DEFAULTS.awaitingInputDelayMs);

  // Fine-tuning a switch marks the verbosity as custom, exactly as in live mode.
  harness.runtime.begin();
  findSwitch(tree, t.evCompleted).props.onClick(false);
  tree = await paint(harness.runtime, harness.Component);
  assert.ok(strings(tree).includes(t.presetCustom), 'the custom marker appears in the generator too');
  assert.ok(strings(tree).includes(t.presetCustomHint));
  assert.equal(normalizeConfig(parseYamlBlock(preText(tree))).events.completed, false);
});

test('the generator still edits webhook targets, and the preview follows', async () => {
  const harness = mount({ namespaces: [] });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);
  assert.ok(strings(tree).includes(t.targetsEmpty));

  harness.runtime.begin();
  findButton(tree, t.targetAdd).props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  assert.ok(findSelect(tree, t.targetType), 'the row appears');
  assert.ok(findSwitch(tree, t.targetEnabled), 'with its own switch');

  // An off target is the feature the user asked for: it stays in the block, switched off.
  harness.runtime.begin();
  findSwitch(tree, t.targetEnabled).props.onClick(false);
  tree = await paint(harness.runtime, harness.Component);
  harness.runtime.begin();
  typeInto(findInput(tree, t.targetUrl), 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc');
  tree = await paint(harness.runtime, harness.Component);
  assert.ok(
    strings(tree).includes(t.detectedPrefix.replace('{provider}', t.typeWecom)),
    'the provider is still sniffed from the URL, exactly as in live mode',
  );

  const maskedPreview = preText(tree);
  assert.equal(findInput(tree, t.targetUrl).props.type, 'password', 'the editor masks the URL');
  assert.equal(maskedPreview.includes('key=abc'), false, 'the generated preview masks it too');
  assert.ok(maskedPreview.includes('<hidden>'));

  harness.runtime.begin();
  findButton(tree, t.genRevealSecrets).props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  const preview = preText(tree);
  assert.ok(preview.includes('webhooks:'), 'the target list is in the block');
  assert.ok(preview.includes('  - enabled: false'), 'an off target is kept, switched off');
  assert.ok(
    preview.includes('url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc"'),
    'and a URL with :// is quoted, so it cannot be misread',
  );
  assert.deepEqual(normalizeConfig(parseYamlBlock(preview)).webhooks, [{
    enabled: false,
    name: 'target-1',
    type: 'auto',
    url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc',
  }]);

  // Removing the row empties the sequence again, in the block as well.
  harness.runtime.begin();
  findButton(tree, t.targetRemove).props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  assert.ok(preText(tree).includes('webhooks: []'));
});

test('recovery preview hides secrets by default while copy keeps the complete YAML', async () => {
  const written = [];
  await withNavigator('en', { writeText: async (value) => { written.push(value); } }, async () => {
    const harness = mount({ namespaces: [] });
    const t = harness.test.STRINGS.en;
    const maskedHeaders = harness.test.maskYamlSecrets([
      'webhooks:',
      '  - url: "https://example.test/hook?token=REVIEW_SECRET"',
      '    headers:',
      '      Authorization: "Bearer REVIEW_SECRET"',
      '    enabled: true',
    ].join('\n'));
    assert.equal(maskedHeaders.includes('REVIEW_SECRET'), false, 'header values are masked with URLs');
    assert.ok(maskedHeaders.includes('Authorization: "<hidden>"'));
    let tree = await paint(harness.runtime, harness.Component);

    harness.runtime.begin();
    findButton(tree, t.targetAdd).props.onClick();
    tree = await paint(harness.runtime, harness.Component);
    harness.runtime.begin();
    typeInto(findInput(tree, t.targetUrl), 'https://example.test/hook?token=REVIEW_SECRET');
    tree = await paint(harness.runtime, harness.Component);

    assert.equal(preText(tree).includes('REVIEW_SECRET'), false);
    assert.equal(preText(tree, 1).includes('REVIEW_SECRET'), false);
    assert.ok(findButton(tree, t.genRevealSecrets));

    findButton(tree, t.genCopy).props.onClick();
    await flushAsync();
    assert.equal(written.length, 1);
    assert.ok(written[0].includes('REVIEW_SECRET'), 'clipboard receives the usable unredacted config');

    harness.runtime.begin();
    findButton(tree, t.genRevealSecrets).props.onClick();
    tree = await paint(harness.runtime, harness.Component);
    assert.ok(preText(tree).includes('REVIEW_SECRET'));
    assert.ok(findButton(tree, t.genHideSecrets));
  });
});

test('the emitter quotes every string a YAML reader would resolve as something else', () => {
  const { yamlScalar, needsQuotes, toYaml } = createModule().exports.__test;

  // Plain where plain is safe — the values this config is full of.
  for (const value of ['auto', 'feishu', 'wecom', 'generic', 'info', 'completed', 'target-1', 'Bearer xxxxxxxx', 'example.internal/dsh/notify', 'My Team']) {
    assert.equal(needsQuotes(value), false, `${JSON.stringify(value)} is safe unquoted`);
    assert.equal(yamlScalar(value), value);
  }

  // Every trigger the rule names, plus the ones a YAML reader also honours: a value
  // that came back as a boolean or a number would silently rewrite the user's config.
  const cases = [
    ['', "''"],
    ['https://open.feishu.cn/open-apis/bot/v2/hook/x', '"https://open.feishu.cn/open-apis/bot/v2/hook/x"'],
    ['a:b', '"a:b"'],
    ['a #b', '"a #b"'],
    ['#tag', '"#tag"'],
    [' padded', '" padded"'],
    ['padded ', '"padded "'],
    ["it's", '"it\'s"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['back\\slash', '"back\\\\slash"'],
    ['123456789', '"123456789"'],
    ['007', '"007"'],
    ['-12.5', '"-12.5"'],
    ['1e3', '"1e3"'],
    ['0x10', '"0x10"'],
    ['true', '"true"'],
    ['FALSE', '"FALSE"'],
    ['yes', '"yes"'],
    ['off', '"off"'],
    ['null', '"null"'],
    ['~', '"~"'],
    ['.inf', '".inf"'],
    ['.nan', '".nan"'],
    ['- leading dash', '"- leading dash"'],
    ['[bracket', '"[bracket"'],
    ['*anchor', '"*anchor"'],
    ['a\nb', '"a\\nb"'],
    ['a\tb', '"a\\tb"'],
  ];
  for (const [value, expected] of cases) {
    assert.equal(needsQuotes(value), true, `${JSON.stringify(value)} needs quotes`);
    assert.equal(yamlScalar(value), expected, `${JSON.stringify(value)} is quoted and escaped`);
    assert.equal(parseYamlBlock(`key: ${yamlScalar(value)}`).key, value, `${JSON.stringify(value)} reads back unchanged`);
  }

  // Real scalars keep their type; `undefined` reads back as "no value".
  assert.equal(yamlScalar(10000), '10000');
  assert.equal(yamlScalar(0), '0');
  assert.equal(yamlScalar(true), 'true');
  assert.equal(yamlScalar(false), 'false');
  assert.equal(yamlScalar(null), 'null');
  assert.equal(yamlScalar(undefined), 'null');
  assert.equal(parseYamlBlock('key: 10000').key, 10000, 'a number comes back a number');
  assert.equal(parseYamlBlock('key: true').key, true, 'a boolean comes back a boolean');

  // Keys stay plain, and a key with no value is never emitted as a bare `key:`.
  assert.equal(toYaml({ a: 1, b: undefined, c: { d: undefined }, e: [], f: [undefined], g: { h: 'x' } }), [
    'a: 1',
    'c: {}',
    'e: []',
    'f: []',
    'g:',
    '  h: x',
  ].join('\n'));
  assert.equal(toYaml({}), '{}');
});

test('the emitter writes the config shape: nested maps and sequences of maps', () => {
  const { toYaml } = createModule().exports.__test;
  const value = {
    enabled: true,
    events: { completed: true, cancelled: false },
    desktop: { appId: '', timeoutMs: 10000 },
    webhooks: [
      { enabled: true, name: 'wecom', type: 'auto', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' },
      { enabled: false, name: 'internal', type: 'generic', url: 'https://example.internal/dsh/notify', headers: { authorization: 'Bearer a:b' } },
    ],
    retries: 1,
  };
  const expected = [
    'enabled: true',
    'events:',
    '  completed: true',
    '  cancelled: false',
    'desktop:',
    "  appId: ''",
    '  timeoutMs: 10000',
    'webhooks:',
    '  - enabled: true',
    '    name: wecom',
    '    type: auto',
    '    url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x"',
    '  - enabled: false',
    '    name: internal',
    '    type: generic',
    '    url: "https://example.internal/dsh/notify"',
    '    headers:',
    '      authorization: "Bearer a:b"',
    'retries: 1',
  ];
  assert.equal(toYaml(value), expected.join('\n'), 'the block is indented as YAML expects');
  assert.deepEqual(parseYamlBlock(toYaml(value)), value, 'and reads back as the same value');
});

test('the generated block round-trips through the host normalizer', () => {
  // The evidence that matters: the preview is parsed by an independent reader for the
  // emitted subset and pushed through the *host's own* `normalizeConfig`, then compared
  // with what the live write path (`patchOf` → `normalizeConfig`) would have produced.
  const { draftFromValue, patchOf, previewConfig, toYaml, pasteBlock, safeYaml } = createModule().exports.__test;

  const live = normalizeConfig({
    locale: 'en',
    minDurationMs: 0,
    desktop: { appId: 'com.example.dsh', timeoutMs: 9000 },
    webhooks: [
      { name: 'Team #1: alerts', type: 'auto', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/a:b#c' },
      { name: 'telegram', enabled: false, type: 'telegram', url: 'https://api.telegram.org/bot1:2/sendMessage', chatId: '007' },
      { name: 'internal', type: 'generic', url: 'https://example.internal/dsh/notify', headers: { authorization: 'Bearer a:b#c', 'x-note': 'true' } },
      { name: 'slack', type: 'slack', url: 'https://hooks.slack.com/services/T000/B000/x', events: { completed: false } },
      { name: 'padded', type: 'generic', url: 'https://example.internal/nl', headers: { 'x-note': '  padded  ' } },
    ],
  });

  const cases = [
    { name: 'the client defaults', draft: draftFromValue(null), base: null },
    { name: 'a live value', draft: draftFromValue(live), base: live },
    { name: 'a live value with edited numbers', draft: { ...draftFromValue(live), minDurationMs: '', retries: '9', desktop: { enabled: false, sound: true } }, base: live },
    { name: 'a live value with hostile text', draft: { ...draftFromValue(live), locale: 'zh', logLevel: 'warn', events: { completed: false, failed: true, awaitingInput: true, attention: true, cancelled: true } }, base: live },
  ];

  for (const item of cases) {
    const config = previewConfig(item.draft, item.base);
    const yamlText = toYaml(config);
    const parsed = parseYamlBlock(yamlText);
    assert.deepEqual(parsed, config, `${item.name}: every value survives encoding and decoding`);
    assert.deepEqual(
      normalizeConfig(parsed),
      normalizeConfig(patchOf(item.draft, item.base)),
      `${item.name}: the host reads back exactly the config the live path would have written`,
    );

    const row = parseYamlBlock(pasteBlock(yamlText));
    assert.deepEqual(row, [{ id: 'notify-hook', config }], `${item.name}: the pasted row carries the same block`);
    assert.deepEqual(
      normalizeConfig(row[0].config),
      normalizeConfig(patchOf(item.draft, item.base)),
      `${item.name}: and the wrapped snippet normalizes identically`,
    );
  }

  // The values that a YAML reader would silently rewrite without the quoting rules:
  // a digit string would come back a number (or, for `007`, an octal 7), `true` and
  // `yes` would come back booleans, and padding would be trimmed away.
  const hostile = previewConfig(draftFromValue(live), live);
  assert.equal(hostile.webhooks[1].chatId, '007');
  assert.equal(parseYamlBlock(toYaml(hostile)).webhooks[1].chatId, '007', 'a digit chat id stays a string');
  assert.equal(parseYamlBlock(toYaml(hostile)).webhooks[2].headers['x-note'], 'true', 'a header that spells a boolean stays a string');
  assert.equal(parseYamlBlock(toYaml(hostile)).webhooks[4].headers['x-note'], '  padded  ', 'and padding survives');
  assert.equal(parseYamlBlock(toYaml(hostile)).desktop.appId, 'com.example.dsh', 'the live appId is printed, not the default');
  assert.equal(parseYamlBlock(toYaml(hostile)).desktop.timeoutMs, 9000);

  // Every field of the host config is present, which is what "replaces the block" needs.
  assert.deepEqual(Object.keys(previewConfig(draftFromValue(null), null)).sort(), Object.keys(normalizeConfig({})).sort());
  assert.deepEqual(Object.keys(previewConfig(draftFromValue(null), null).desktop).sort(), Object.keys(normalizeConfig({}).desktop).sort());

  // A snippet that cannot be generated degrades to empty text instead of throwing.
  const cyclic = { name: 'loop' };
  cyclic.headers = { self: cyclic };
  const looping = { webhooks: [{ name: 'loop', url: 'https://example.com/hook', keep: { headers: { self: cyclic } } }] };
  assert.throws(() => toYaml(previewConfig(looping, null)), /deep|cyclic/i, 'the emitter refuses rather than guessing');
  assert.equal(safeYaml(looping, null), '', 'and the panel-facing wrapper returns empty text');
  assert.ok(safeYaml(draftFromValue(null), null).startsWith('enabled:'), 'while a normal draft is unaffected');
  assert.equal(pasteBlock(''), '- id: notify-hook\n  config:\n', 'an empty block still yields a valid snippet');
});

test('Copy puts a snippet on the clipboard and confirms it', async () => {
  const written = [];
  await withNavigator('en', { writeText: async (value) => { written.push(value); } }, async () => {
    const harness = mount({ namespaces: [] });
    const t = harness.test.STRINGS.en;
    let tree = await paint(harness.runtime, harness.Component);
    const preview = preText(tree);
    const row = preText(tree, 1);

    harness.runtime.begin();
    assert.doesNotThrow(() => findButton(tree, t.genCopy).props.onClick());
    await flushAsync();
    tree = await paint(harness.runtime, harness.Component);
    assert.deepEqual(written, [preview], 'the preview reached the clipboard');
    assert.ok(findButton(tree, t.genCopied), 'and the button reports it');
    assert.equal(elements(tree).some((el) => el.type === 'textarea'), false, 'no manual fallback was needed');

    // The paste block has its own button, and copies the row wrapper.
    harness.runtime.begin();
    findButton(tree, t.genPasteCopy).props.onClick();
    await flushAsync();
    tree = await paint(harness.runtime, harness.Component);
    assert.deepEqual(written, [preview, row], 'the whole row goes to the clipboard too');
    assert.ok(row.startsWith('- id: notify-hook'), 'and it is the row, not the bare block');
    assert.equal(findButton(tree, t.genPasteCopy), null, 'the row button is the one reporting the copy now');
    assert.ok(findButton(tree, t.genCopy), 'and the preview button offers a copy again');

    // An edit retires the confirmation: it referred to the snippet that was on screen
    // when the button was pressed, not to the one the edit just produced.
    harness.runtime.begin();
    findSwitch(tree, t.masterLabel).props.onClick();
    tree = await paint(harness.runtime, harness.Component);
    assert.equal(findButton(tree, t.genCopied), null, 'no stale "Copied" survives a change');
    assert.ok(findButton(tree, t.genPasteCopy) && findButton(tree, t.genCopy), 'both buttons offer a fresh copy');
    assert.ok(preText(tree).startsWith('enabled: false'), 'the edit itself landed');
  });
});

test('Copy never throws and degrades to a selectable textarea', async () => {
  // 1. No clipboard API at all, which is what an insecure context looks like.
  await withNavigator('en', undefined, async () => {
    const harness = mount({ namespaces: [] });
    const t = harness.test.STRINGS.en;
    let tree = await paint(harness.runtime, harness.Component);
    const preview = preText(tree);

    harness.runtime.begin();
    assert.doesNotThrow(() => findButton(tree, t.genCopy).props.onClick());
    await flushAsync();
    tree = await paint(harness.runtime, harness.Component);

    assert.equal(textareaValue(tree), preview, 'the text is on screen to select by hand');
    assert.ok(strings(tree).includes(t.genManualHint), 'with an explanation');
    assert.equal(findButton(tree, t.genCopied), null, 'and no false claim of success');

    // Selecting it is a convenience; a synthetic or missing event must not throw.
    const area = elements(tree).find((el) => el.type === 'textarea');
    let selected = 0;
    area.props.onClick({ target: { select() { selected += 1; } } });
    assert.equal(selected, 1, 'a click selects the whole snippet');
    assert.doesNotThrow(() => area.props.onClick(null));
    assert.doesNotThrow(() => area.props.onFocus({ target: {} }));
    assert.equal(area.props.readOnly, true, 'the fallback is read-only, so it cannot drift from the preview');
  });

  // 2. The clipboard exists and the write is refused.
  await withNavigator('en', { writeText: async () => { throw new Error('denied'); } }, async () => {
    const harness = mount({ namespaces: [] });
    const t = harness.test.STRINGS.en;
    let tree = await paint(harness.runtime, harness.Component);
    harness.runtime.begin();
    assert.doesNotThrow(() => findButton(tree, t.genCopy).props.onClick());
    await flushAsync();
    tree = await paint(harness.runtime, harness.Component);
    assert.ok(textareaValue(tree), 'a refusal falls back to the textarea');
    assert.equal(findButton(tree, t.genCopied), null, 'and is not reported as a copy');
  });

  // 3. `writeText` that throws synchronously rather than rejecting.
  await withNavigator('en', { writeText: () => { throw new Error('nope'); } }, async () => {
    const harness = mount({ namespaces: [] });
    const t = harness.test.STRINGS.en;
    const tree = await paint(harness.runtime, harness.Component);
    harness.runtime.begin();
    assert.doesNotThrow(() => findButton(tree, t.genCopy).props.onClick());
    await flushAsync();
    const after = await paint(harness.runtime, harness.Component);
    assert.ok(textareaValue(after));
  });
});

/* ================================================================== *
 * presets
 * ================================================================== */

test('presetFor maps the four presets and reports anything else as custom', () => {
  const { PRESETS, presetFor } = createModule().exports.__test;
  for (const key of Object.keys(PRESETS)) {
    assert.equal(presetFor(PRESETS[key].events, PRESETS[key].minDurationMs), key);
  }
  assert.equal(presetFor(HOST_DEFAULTS.events, HOST_DEFAULTS.minDurationMs), 'balanced');
  assert.equal(presetFor(PRESETS.balanced.events, '10000'), 'balanced', 'the draft holds strings');
  assert.equal(presetFor({ ...PRESETS.balanced.events, cancelled: true }, 10000), 'custom');
  assert.equal(presetFor(PRESETS.balanced.events, 10001), 'custom');
  assert.equal(presetFor(PRESETS.silent.events, 0), 'custom');
  assert.equal(presetFor(undefined, undefined), 'custom');
});

test('choosing a preset writes both events and the minimum duration', async () => {
  const harness = mount({ value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' } });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);

  const detailed = elements(tree).find((el) => textOf(el) === t.presetDetailed);
  assert.equal(detailed.props['aria-checked'], 'false');

  harness.runtime.begin();
  detailed.props.onClick();
  tree = await paint(harness.runtime, harness.Component);

  assert.equal(findSwitch(tree, t.evCancelled).props['aria-checked'], 'true');
  assert.equal(findInput(tree, t.fieldMinDuration).props.value, '0');
  assert.ok(strings(tree).includes(t.presetDetailedHint));

  // Fine-tuning one switch moves the marker to custom without touching the rest.
  harness.runtime.begin();
  findSwitch(tree, t.evFailed).props.onClick(false);
  tree = await paint(harness.runtime, harness.Component);
  assert.ok(strings(tree).includes(t.presetCustom));
  assert.ok(strings(tree).includes(t.presetCustomHint));
  assert.equal(findInput(tree, t.fieldMinDuration).props.value, '0', 'the duration is left alone');
});

test('every preset has a label and an explanation, and each writes its own values', async () => {
  const { PRESETS } = createModule().exports.__test;
  const harness = mount({ value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' } });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);

  for (const key of Object.keys(PRESETS)) {
    const name = `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    const option = elements(tree).find((el) => el.type === 'button' && (el.props || {}).role === 'radio' && textOf(el) === t[`preset${name}`]);
    assert.ok(option, `${key}: the preset is offered`);

    harness.runtime.begin();
    option.props.onClick();
    tree = await paint(harness.runtime, harness.Component);

    const all = strings(tree);
    assert.ok(all.includes(t[`preset${name}`]), `${key}: the label is rendered`);
    assert.ok(all.includes(t[`preset${name}Hint`]), `${key}: the explanation is rendered`);
    assert.equal(all.includes(t.presetCustom), false, `${key}: not reported as custom`);
    assert.equal(findInput(tree, t.fieldMinDuration).props.value, String(PRESETS[key].minDurationMs), `${key}: the duration follows`);
    for (const eventKey of ['completed', 'failed', 'awaitingInput', 'attention', 'cancelled']) {
      const label = {
        completed: t.evCompleted,
        failed: t.evFailed,
        awaitingInput: t.evAwaitingInput,
        attention: t.evAttention,
        cancelled: t.evCancelled,
      }[eventKey];
      assert.equal(
        findSwitch(tree, label).props['aria-checked'],
        String(PRESETS[key].events[eventKey]),
        `${key}: ${eventKey} follows the preset`,
      );
    }
  }
});

/* ================================================================== *
 * saving
 * ================================================================== */

test('wrapped update response is adopted after save', async () => {
  const harness = mount({ value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' } });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);

  harness.runtime.begin();
  findSwitch(tree, t.evCancelled).props.onClick(true);
  tree = await paint(harness.runtime, harness.Component);

  const save = findButton(tree, t.footerSave);
  assert.equal(save.props.disabled, false, 'a change makes the form dirty');
  assert.ok(strings(tree).includes(t.statusUnsaved));

  await save.props.onClick();
  await flushAsync();

  assert.equal(harness.updates.length, 1);
  const sent = harness.updates[0];
  assert.equal(sent.ns, 'include:notify-hook');
  assert.equal(sent.revision, 3, 'the expected revision is passed through');
  assert.equal(sent.patch.events.cancelled, true);
  assert.equal(sent.patch.events.completed, HOST_DEFAULTS.events.completed);
  assert.equal(sent.patch.enabled, HOST_DEFAULTS.enabled);
  assert.equal(sent.patch.locale, 'en');
  assert.equal(sent.patch.minDurationMs, HOST_DEFAULTS.minDurationMs);
  assert.equal(sent.patch.awaitingInputDelayMs, HOST_DEFAULTS.awaitingInputDelayMs);
  assert.equal(sent.patch.dedupeWindowMs, HOST_DEFAULTS.dedupeWindowMs);
  assert.equal(sent.patch.desktop.enabled, true);
  assert.equal(sent.patch.desktop.sound, false);
  assert.equal(sent.patch.desktop.appId, HOST_DEFAULTS.desktop.appId, 'untouched desktop fields survive');
  assert.equal(sent.patch.desktop.timeoutMs, HOST_DEFAULTS.desktop.timeoutMs);
  assert.equal(sent.patch.timeoutMs, HOST_DEFAULTS.timeoutMs);
  assert.equal(sent.patch.retries, HOST_DEFAULTS.retries);
  assert.equal(sent.patch.logLevel, HOST_EFFECTIVE_DEFAULTS.logLevel);
  assert.equal(sent.patch.logDeliveries, HOST_DEFAULTS.logDeliveries);
  assert.equal(sent.patch.includeSubagents, HOST_DEFAULTS.includeSubagents);
  assert.equal(sent.patch.testOnActivate, false);
  assert.deepEqual(sent.patch.webhooks, []);

  tree = await paint(harness.runtime, harness.Component);
  assert.ok(strings(tree).includes(t.statusSaved));
  assert.equal(findButton(tree, t.footerSave).props.disabled, true, 'clean again after the write');

  harness.runtime.begin();
  findSwitch(tree, t.evCancelled).props.onClick(false);
  tree = await paint(harness.runtime, harness.Component);
  await findButton(tree, t.footerSave).props.onClick();
  assert.equal(harness.updates[1].revision, 4, 'the revision from response.value is adopted');
});

test('a Remote refusal keeps the draft and reports the failure', async () => {
  const harness = mount({
    value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' },
    update: async () => remoteFail('revision conflict'),
  });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);

  harness.runtime.begin();
  findSwitch(tree, t.evCancelled).props.onClick(true);
  tree = await paint(harness.runtime, harness.Component);
  await findButton(tree, t.footerSave).props.onClick();
  await flushAsync();
  tree = await paint(harness.runtime, harness.Component);

  assert.ok(strings(tree).some((line) => line.includes('revision conflict')), 'the error reaches the footer');
  assert.equal(findSwitch(tree, t.evCancelled).props['aria-checked'], 'true', 'the draft survives');
  assert.equal(findButton(tree, t.footerSave).props.disabled, false, 'still saveable');
});

test('a write that returns no live value closes the write surface', async () => {
  // The other half of the "a view without a usable value is not a configuration" rule:
  // if `update` answers with `value: null`, the draft on screen no longer has a live
  // value behind it, so re-sending it (Save, or the test dance, which writes the whole
  // form) would push this client's own defaults into the row.
  const writes = [];
  const harness = mount({
    value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' },
    update: async (ns, patch, expectedRevision) => {
      writes.push({ ns, patch, revision: expectedRevision });
      return remoteOk({ ns, revision: 4, value: null });
    },
  });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);

  harness.runtime.begin();
  findSwitch(tree, t.evCancelled).props.onClick(true);
  tree = await paint(harness.runtime, harness.Component);
  await findButton(tree, t.footerSave).props.onClick();
  await flushAsync();
  tree = await paint(harness.runtime, harness.Component);

  assert.equal(writes.length, 1, 'the write itself went through');
  assert.ok(strings(tree).includes(t.statusSaved), 'and was reported as saved');
  assert.equal(findButton(tree, t.footerSave).props.disabled, true, 'Save has nothing live to merge into');
  assert.equal(findButton(tree, t.footerSendTest).props.disabled, true, 'and neither has the test button');
  assert.equal(strings(tree).includes(t.fallbackTitle), false, 'the panel itself keeps working');
});

test('number fields are clamped to the host limits on the way out', async () => {
  const harness = mount({ value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' } });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);

  harness.runtime.begin();
  typeInto(findInput(tree, t.fieldRetries), '9');
  typeInto(findInput(tree, t.fieldTimeout), '10');
  typeInto(findInput(tree, t.fieldMinDuration), '');
  tree = await paint(harness.runtime, harness.Component);
  await findButton(tree, t.footerSave).props.onClick();
  await flushAsync();

  const sent = harness.updates[0].patch;
  assert.equal(sent.retries, 3);
  assert.equal(sent.timeoutMs, 250);
  assert.equal(sent.minDurationMs, HOST_DEFAULTS.minDurationMs, 'an emptied field falls back to the default');
});

test('only an exact boolean true arms an event in the patch', () => {
  // The host stores an event with `bool(value, default)`; anything that is not a boolean
  // becomes the *default*, and four of the five defaults are `true`. So a truthy string
  // leaking into the patch would not merely be sloppy — the host would read `'yes'` as
  // the default and switch the event ON. The patch therefore carries real booleans only.
  const { patchOf } = createModule().exports.__test;
  const patch = patchOf({
    events: { completed: 'yes', failed: 1, awaitingInput: true, attention: null, cancelled: 'false' },
  }, null);

  assert.deepEqual(patch.events, {
    completed: false,
    failed: false,
    awaitingInput: true,
    attention: false,
    cancelled: false,
  });
  for (const [key, value] of Object.entries(patch.events)) {
    assert.equal(typeof value, 'boolean', `events.${key} is a real boolean`);
  }
  // An absent map is all-off, not all-default.
  assert.deepEqual(patchOf({}, null).events, {
    completed: false,
    failed: false,
    awaitingInput: false,
    attention: false,
    cancelled: false,
  });
});

/* ================================================================== *
 * webhook targets
 * ================================================================== */

test('an unknown explicit webhook type survives the draft and the patch untouched', async () => {
  // The host refuses to deliver an unknown explicit type (`lib/payloads.js` throws
  // `PayloadError`, deliberately: "a config error, not a runtime failure"). Showing the
  // row as `auto` and writing `auto` back on the next Save converted that loud refusal
  // into silent live delivery to a provider the user never chose.
  const { draftFromValue, patchOf, targetTypeOf } = createModule().exports.__test;
  const value = {
    ...JSON.parse(JSON.stringify(HOST_DEFAULTS)),
    locale: 'en',
    webhooks: [{
      name: 'legacy',
      type: 'feishu-v3',
      url: 'https://api.telegram.org/bot1:x/sendMessage',
      chatId: '4242',
    }],
  };

  const draft = draftFromValue(value);
  assert.equal(draft.webhooks[0].type, 'feishu-v3', 'the draft keeps the stored type');
  const patch = patchOf(draft, null);
  assert.equal(patch.webhooks[0].type, 'feishu-v3', 'and the patch sends the same string back');
  assert.equal(patch.webhooks[0].chatId, '4242', 'the fields the row cannot display are still written');
  // The row is not a sniffed provider: the host will not deliver it at all.
  assert.equal(
    targetTypeOf({ type: 'feishu-v3', url: 'https://api.telegram.org/bot1:x/sendMessage' }),
    'feishu-v3',
    'an explicit type is never reported as a sniffed one',
  );

  // End to end through the real host normalizer (`mount`'s fake host uses it).
  const harness = mount({ value });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);
  const select = findSelect(tree, t.targetType);
  assert.ok(select, 'the row is rendered');
  assert.equal(select.props.value, 'feishu-v3', 'the select shows the stored value, not the first option');
  assert.deepEqual(
    select.children.map((option) => option.props.value),
    ['auto', 'feishu', 'wecom', 'telegram', 'discord', 'slack', 'generic', 'feishu-v3'],
    'the stored type is offered as its own option',
  );
  const unknownLabel = t.typeUnknown.replace('{type}', 'feishu-v3');
  assert.ok(strings(select).includes(unknownLabel), 'and that option is marked as unknown');
  assert.equal(findInput(tree, t.targetChatId), null, 'a row the host refuses is not offered telegram-only fields');

  // A Save keeps it exactly as it was.
  harness.runtime.begin();
  typeInto(findInput(tree, t.targetUrl), 'https://api.telegram.org/bot2:y/sendMessage');
  tree = await paint(harness.runtime, harness.Component);
  await findButton(tree, t.footerSave).props.onClick();
  await flushAsync();
  assert.equal(harness.updates[0].patch.webhooks[0].type, 'feishu-v3');
  tree = await paint(harness.runtime, harness.Component);
  assert.equal(findSelect(tree, t.targetType).props.value, 'feishu-v3', 'still unknown after the write');
  assert.ok(
    strings(tree).includes(t.typeUnknown.replace('{type}', 'feishu-v3')),
    'and still labelled as unknown',
  );
});

test('a blank or absent webhook type still means auto-detect', () => {
  // The other side of the rule above: only a *stored* value is preserved; nothing is
  // invented for a row that never had one.
  const { draftFromValue, patchOf, rowFromValue, newRow } = createModule().exports.__test;
  assert.equal(rowFromValue({ type: '', url: 'https://example.com/hook' }).type, 'auto');
  assert.equal(rowFromValue({ url: 'https://example.com/hook' }).type, 'auto');
  assert.equal(rowFromValue({ type: 7, url: 'https://example.com/hook' }).type, 'auto', 'a non-string type is not a type');
  assert.equal(newRow('auto').type, 'auto');
  assert.equal(draftFromValue({ webhooks: [{ url: 'https://example.com/a' }] }).webhooks[0].type, 'auto');
  assert.equal(patchOf(draftFromValue({ webhooks: [{ url: 'https://example.com/a' }] }), null).webhooks[0].type, 'auto');
});

test('per-target enable is part of the saved patch', async () => {
  const value = {
    ...JSON.parse(JSON.stringify(HOST_DEFAULTS)),
    locale: 'en',
    webhooks: [
      { name: 'feishu', type: 'auto', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' },
      { name: 'wecom', type: 'auto', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xyz' },
    ],
  };
  const harness = mount({ value });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);

  const switches = elements(tree).filter((el) => (el.props || {}).role === 'switch' && el.props['aria-label'] === t.targetEnabled);
  assert.equal(switches.length, 2, 'one switch per target');
  assert.equal(switches[0].props['aria-checked'], 'true');

  harness.runtime.begin();
  switches[1].props.onClick(false);
  tree = await paint(harness.runtime, harness.Component);

  assert.equal(findButton(tree, t.footerSave).props.disabled, false);
  await findButton(tree, t.footerSave).props.onClick();
  await flushAsync();

  const rows = harness.updates[0].patch.webhooks;
  assert.equal(rows.length, 2, 'an off target is kept in the list');
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[1].enabled, false);
  assert.equal(rows[1].name, 'wecom', 'the row itself is untouched');
  assert.equal(rows[1].url, value.webhooks[1].url);
  assert.equal(rows[1].type, 'auto');

  // The switch survives a round trip through the host's own normalizer.
  tree = await paint(harness.runtime, harness.Component);
  const after = elements(tree).filter((el) => (el.props || {}).role === 'switch' && el.props['aria-label'] === t.targetEnabled);
  assert.equal(after[0].props['aria-checked'], 'true');
  assert.equal(after[1].props['aria-checked'], 'false', 'the off target is still off after saving');
});

test('an enabled target without a usable URL blocks saving and is marked', async () => {
  const harness = mount({
    value: {
      ...JSON.parse(JSON.stringify(HOST_DEFAULTS)),
      locale: 'en',
      webhooks: [{ name: 'draft', type: 'auto', url: 'ftp://example.com/hook' }],
    },
  });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);

  assert.equal(findButton(tree, t.footerSave).props.disabled, true);
  assert.equal(findButton(tree, t.footerSendTest).props.disabled, true, 'the test button writes the same patch');
  assert.ok(strings(tree).includes(t.urlInvalid));
  assert.ok(strings(tree).includes(t.fixRowsFirst));

  // Empty is reported differently from a wrong scheme.
  harness.runtime.begin();
  typeInto(findInput(tree, t.targetUrl), '');
  tree = await paint(harness.runtime, harness.Component);
  assert.ok(strings(tree).includes(t.urlMissing));

  // Switching the row off is the other way out, and it is itself a change worth saving.
  harness.runtime.begin();
  findSwitch(tree, t.targetEnabled).props.onClick(false);
  tree = await paint(harness.runtime, harness.Component);
  assert.equal(findButton(tree, t.footerSave).props.disabled, false);
  assert.ok(strings(tree).includes(t.rowDisabledHint));
  assert.equal(strings(tree).includes(t.urlMissing), false, 'the complaint goes away with the row');
});

test('a target row can be added, typed and removed', async () => {
  const harness = mount({ value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' } });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);
  assert.ok(strings(tree).includes(t.targetsEmpty));

  harness.runtime.begin();
  findButton(tree, t.targetAdd).props.onClick();
  tree = await paint(harness.runtime, harness.Component);

  // A fresh enabled row has no URL yet, so the form refuses to save it.
  assert.equal(findButton(tree, t.footerSave).props.disabled, true);
  assert.ok(strings(tree).includes(t.urlMissing));
  assert.equal(findSelect(tree, t.targetType).props.value, 'auto', 'a plain row sniffs the provider');

  // Typing a provider URL makes the detected provider visible under auto-detect.
  harness.runtime.begin();
  typeInto(findInput(tree, t.targetUrl), 'https://open.feishu.cn/open-apis/bot/v2/hook/abc');
  tree = await paint(harness.runtime, harness.Component);
  assert.ok(strings(tree).includes(t.detectedPrefix.replace('{provider}', 'Feishu')), 'the auto-detected provider is named next to the URL');
  assert.equal(findButton(tree, t.footerSave).props.disabled, false);

  // Quick add pre-fills both a readable name and the type, as a second row.
  harness.runtime.begin();
  findButton(tree, t.typeTelegram).props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  const selects = elements(tree).filter((el) => el.type === 'select' && (el.props || {})['aria-label'] === t.targetType);
  assert.equal(selects.length, 2, 'a second target row');
  assert.equal(selects[1].props.value, 'telegram', 'quick add pre-fills the type');
  const names = elements(tree).filter((el) => el.type === 'input' && (el.props || {})['aria-label'] === t.targetName);
  assert.equal(names[1].props.value, 'Telegram', 'and a readable name');

  // Remove the empty row again; the configured one stays.
  const removes = elements(tree).filter((el) => el.type === 'button' && textOf(el) === t.targetRemove);
  assert.equal(removes.length, 2);
  harness.runtime.begin();
  removes[1].props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  assert.equal(
    elements(tree).filter((el) => el.type === 'select' && (el.props || {})['aria-label'] === t.targetType).length,
    1,
    'only the configured row is left',
  );
  assert.equal(strings(tree).includes(t.targetsEmpty), false);

  harness.runtime.begin();
  findButton(tree, t.targetRemove).props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  assert.ok(strings(tree).includes(t.targetsEmpty), 'the row is gone again');
});

test('revision conflicts can reread and reapply the draft before saving', async () => {
  const original = { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en', logDeliveries: true };
  const latest = { ...JSON.parse(JSON.stringify(original)), logDeliveries: false };
  let describes = 0;
  const writes = [];
  const harness = mount({
    value: original,
    describe: async () => {
      describes += 1;
      const value = describes === 1 ? original : latest;
      const revision = describes === 1 ? 3 : 4;
      return remoteOk({ writable: true, hasDocument: true, namespaces: [namespace(value, revision)] });
    },
    update: async (ns, patch, revision) => {
      writes.push({ ns, patch, revision });
      if (revision === 3) return remoteFail('revision conflict');
      return remoteOk(namespace(normalizeConfig({ ...latest, ...patch }), 5, ns));
    },
  });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);

  harness.runtime.begin();
  findSwitch(tree, t.evCancelled).props.onClick(true);
  tree = await paint(harness.runtime, harness.Component);
  await findButton(tree, t.footerSave).props.onClick();
  await flushAsync();
  tree = await paint(harness.runtime, harness.Component);

  const reload = findButton(tree, t.footerReloadLatest);
  assert.ok(reload, 'a failed save offers an explicit conflict recovery action');
  await reload.props.onClick();
  await flushAsync();
  tree = await paint(harness.runtime, harness.Component);

  assert.equal(findSwitch(tree, t.evCancelled).props['aria-checked'], 'true', 'the local edit survives');
  assert.equal(findSwitch(tree, t.fieldLogDeliveries).props['aria-checked'], 'false', 'an untouched field adopts the server change');
  assert.ok(strings(tree).includes(t.statusRebased));

  await findButton(tree, t.footerSave).props.onClick();
  await flushAsync();
  assert.equal(writes.at(-1).revision, 4, 'the retry uses the fresh authoritative revision');
  assert.equal(writes.at(-1).patch.events.cancelled, true);
  assert.equal(writes.at(-1).patch.logDeliveries, false);
});

test('webhook URLs are masked until explicitly revealed', async () => {
  const value = {
    ...JSON.parse(JSON.stringify(HOST_DEFAULTS)),
    locale: 'en',
    webhooks: [
      { name: 'one', type: 'generic', url: 'https://example.com/one' },
      { name: 'two', type: 'generic', url: 'https://example.com/two' },
    ],
  };
  const harness = mount({ value });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);
  const urlInputs = () => elements(tree).filter((el) => el.type === 'input' && (el.props || {})['aria-label'] === t.targetUrl);

  assert.deepEqual(urlInputs().map((input) => input.props.type), ['password', 'password']);
  const revealButtons = elements(tree).filter((el) => el.type === 'button' && textOf(el) === t.targetReveal);
  assert.equal(revealButtons.length, 2, 'each target controls its own secret');

  harness.runtime.begin();
  revealButtons[0].props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  assert.deepEqual(urlInputs().map((input) => input.props.type), ['text', 'password'], 'only the selected row is revealed');

  harness.runtime.begin();
  findButton(tree, t.targetHide).props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  assert.deepEqual(urlInputs().map((input) => input.props.type), ['password', 'password']);
});

test('webhook reveal state is cleared when rows are structurally edited', async () => {
  const value = {
    ...JSON.parse(JSON.stringify(HOST_DEFAULTS)),
    locale: 'en',
    webhooks: [
      { name: 'one', type: 'generic', url: 'https://example.com/one' },
      { name: 'two', type: 'generic', url: 'https://example.com/two' },
    ],
  };
  const harness = mount({ value });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);
  const urlTypes = () => elements(tree)
    .filter((el) => el.type === 'input' && (el.props || {})['aria-label'] === t.targetUrl)
    .map((input) => input.props.type);

  harness.runtime.begin();
  findButton(tree, t.targetReveal).props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  assert.equal(urlTypes()[0], 'text');

  harness.runtime.begin();
  findButton(tree, t.targetAdd).props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  assert.deepEqual(urlTypes(), ['password', 'password', 'password'], 'adding a row masks every row again');

  harness.runtime.begin();
  findButton(tree, t.targetReveal).props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  assert.equal(urlTypes()[0], 'text');
  const removes = elements(tree).filter((el) => el.type === 'button' && textOf(el) === t.targetRemove);
  harness.runtime.begin();
  removes[2].props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  assert.deepEqual(urlTypes(), ['password', 'password'], 'removing a row masks every row again');
});

test('authoritative adoption clears indexed webhook reveal state after row reorder', async () => {
  const value = {
    ...JSON.parse(JSON.stringify(HOST_DEFAULTS)),
    locale: 'en',
    webhooks: [
      { name: 'one', type: 'generic', url: 'https://example.com/one' },
      { name: 'two', type: 'generic', url: 'https://example.com/two' },
    ],
  };
  const harness = mount({
    value,
    update: async (ns, patch, revision) => remoteOk(namespace({
      ...value,
      ...patch,
      webhooks: [...value.webhooks].reverse(),
    }, revision + 1, ns)),
  });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);

  harness.runtime.begin();
  findButton(tree, t.targetReveal).props.onClick();
  tree = await paint(harness.runtime, harness.Component);
  harness.runtime.begin();
  findSwitch(tree, t.evCancelled).props.onClick(true);
  tree = await paint(harness.runtime, harness.Component);
  await findButton(tree, t.footerSave).props.onClick();
  await flushAsync();
  tree = await paint(harness.runtime, harness.Component);

  const urlTypes = elements(tree)
    .filter((el) => el.type === 'input' && (el.props || {})['aria-label'] === t.targetUrl)
    .map((input) => input.props.type);
  assert.deepEqual(urlTypes, ['password', 'password']);
});

test('UI messages redact credential-bearing URLs', () => {
  const { sanitizeUiMessage } = createModule().exports.__test;
  const secretUrl = 'https://api.telegram.org/botSECRET/sendMessage?token=SECRET';
  assert.equal(typeof sanitizeUiMessage, 'function');
  const result = sanitizeUiMessage(`delivery failed at ${secretUrl}`);
  assert.ok(result.includes('[redacted URL]'));
  assert.equal(result.includes(secretUrl), false);
  assert.equal(result.includes('SECRET'), false);

  const quoted = sanitizeUiMessage("delivery failed at https://example.test/hook?token='REVIEW_SECRET'");
  assert.equal(quoted.includes('REVIEW_SECRET'), false, quoted);
  assert.equal(quoted.includes("'"), false, quoted);
});

test('Remote failures never render or log a webhook secret', async () => {
  const secretUrl = "https://api.telegram.org/botSECRET/sendMessage?token='SECRET'";
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { logs.push(args.map((value) => String(value)).join(' ')); };
  try {
    const harness = mount({
      value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' },
      update: async () => remoteFail(`revision conflict at ${secretUrl}`),
    });
    const t = harness.test.STRINGS.en;
    let tree = await paint(harness.runtime, harness.Component);
    harness.runtime.begin();
    findSwitch(tree, t.evCancelled).props.onClick(true);
    tree = await paint(harness.runtime, harness.Component);
    await findButton(tree, t.footerSave).props.onClick();
    await flushAsync();
    tree = await paint(harness.runtime, harness.Component);

    const rendered = strings(tree).join(' ');
    const logged = logs.join(' ');
    for (const output of [rendered, logged]) {
      assert.equal(output.includes(secretUrl), false, 'the full URL is absent');
      assert.equal(output.includes('SECRET'), false, 'credential fragments are absent');
    }
    assert.ok(rendered.includes('[redacted URL]'), 'the user still receives an actionable redaction marker');
  } finally {
    console.warn = originalWarn;
  }
});

test('the chat id only appears for telegram targets', async () => {
  const harness = mount({
    value: {
      ...JSON.parse(JSON.stringify(HOST_DEFAULTS)),
      locale: 'en',
      webhooks: [{ name: 'tg', type: 'telegram', url: 'https://api.telegram.org/bot123:abc/sendMessage' }],
    },
  });
  const t = harness.test.STRINGS.en;
  let tree = await paint(harness.runtime, harness.Component);
  assert.ok(findInput(tree, t.targetChatId), 'telegram asks for a chat id');

  // The type select offers every provider, each labelled in the UI language.
  assert.deepEqual(
    findSelect(tree, t.targetType).children.map((option) => textOf(option)),
    [t.typeAuto, t.typeFeishu, t.typeWecom, t.typeTelegram, t.typeDiscord, t.typeSlack, t.typeGeneric],
  );

  harness.runtime.begin();
  choose(findSelect(tree, t.targetType), 'slack');
  tree = await paint(harness.runtime, harness.Component);
  assert.equal(findInput(tree, t.targetChatId), null, 'other providers do not');

  // A telegram URL under auto-detect behaves like an explicit telegram type.
  harness.runtime.begin();
  choose(findSelect(tree, t.targetType), 'auto');
  tree = await paint(harness.runtime, harness.Component);
  assert.ok(findInput(tree, t.targetChatId), 'auto-detected telegram still asks');
});

test('provider detection mirrors the host implementation', () => {
  const { detectTargetType, targetTypeOf } = createModule().exports.__test;
  const urls = [
    'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx',
    'https://api.telegram.org/bot123456:AAH/sendMessage',
    'https://telegram.org/whatever',
    'https://discord.com/api/webhooks/000000/xxxxxxxx',
    'https://discordapp.com/api/webhooks/000000/xxxxxxxx',
    'https://hooks.slack.com/services/T000/B000/xxxxxxxx',
    'https://example.slack.com/services/T000',
    'https://example.internal/dsh/notify',
    'https://example.com/api/webhooks/1',
    'https://example.com/open-apis/bot/v2/hook/x',
    'https://example.com/cgi-bin/webhook/send',
    'not a url',
    '',
    'https://sub.feishu.cn/x',
  ];
  for (const url of urls) {
    assert.equal(detectTargetType(url), hostDetectTargetType(url), `detection agrees for ${JSON.stringify(url)}`);
  }
  assert.equal(targetTypeOf({ type: 'auto', url: 'https://api.telegram.org/bot1:x/sendMessage' }), 'telegram');
  assert.equal(targetTypeOf({ type: 'generic', url: 'https://api.telegram.org/bot1:x/sendMessage' }), 'generic');
});

test('the provider mirror also agrees on hosts that only *contain* a provider name', () => {
  // The parity list above only used hosts where a suffix test and a substring test
  // agree, so the client's host rule (mirroring `lib/payloads.js:97`) was never pinned:
  // `eviltelegram.org` ends with neither `telegram.org` nor `.telegram.org`. Being
  // wrong here shows the user a provider the host will not deliver as.
  const { detectTargetType } = createModule().exports.__test;
  /** @type {Array<[string, string]>} */
  const cases = [
    ['https://eviltelegram.org/x', 'generic'],
    ['https://xdiscordapp.com/x', 'generic'],
    ['https://xweixin.qq.com/x', 'generic'],
    ['https://discord.com.evil.com/x', 'generic'],
    ['https://my-slack.com/services/T', 'generic'],
    ['https://slack.com.evil.com/services/T', 'generic'],
    ['https://evil.com/services/', 'generic'],
    // Path heuristics are part of the host's rule too, so they must keep matching.
    ['https://evil.com/cgi-bin/webhook/', 'wecom'],
    ['https://evil.com/open-apis/bot/', 'feishu'],
    ['https://evil.com/api/webhooks/', 'discord'],
    // Substring matching is genuinely part of the host's own rule, so these stay.
    ['https://notfeishu.cn.evil.com/x', 'feishu'],
    ['https://xopen.feishu.cn/y', 'feishu'],
    ['ftp://open.feishu.cn/x', 'feishu'],
    ['https://telegram.org.evil.com/x', 'generic'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(detectTargetType(url), hostDetectTargetType(url), `detection agrees for ${JSON.stringify(url)}`);
    assert.equal(detectTargetType(url), expected, `${JSON.stringify(url)} resolves as the host does`);
  }
});

/* ================================================================== *
 * test notification
 * ================================================================== */

test('the test button writes testOnActivate on, waits, then writes it off', async () => {
  const harness = mount({ value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' } });
  const t = harness.test.STRINGS.en;
  harness.test.TEST_DISARM_DELAY_MS.current = 0;
  const tree = await paint(harness.runtime, harness.Component);

  const button = findButton(tree, t.footerSendTest);
  assert.equal(button.props.disabled, false);
  await button.props.onClick();
  await flushAsync();

  assert.equal(harness.updates.length, 2, 'exactly two writes');
  assert.equal(harness.updates[0].ns, 'include:notify-hook');
  assert.equal(harness.updates[0].revision, 3);
  assert.equal(harness.updates[0].patch.testOnActivate, true, 'step one arms the row');
  assert.equal(harness.updates[0].patch.events.completed, HOST_DEFAULTS.events.completed, 'and saves the form with it');
  assert.deepEqual(harness.updates[1].patch, { testOnActivate: false }, 'step two disarms and writes nothing else');
  assert.equal(harness.updates[1].revision, 4, 'step two uses the revision step one returned');
});

test('a failed test write is reported and leaves nothing armed', async () => {
  const harness = mount({
    value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' },
    update: async () => remoteFail('row unloaded'),
  });
  const t = harness.test.STRINGS.en;
  harness.test.TEST_DISARM_DELAY_MS.current = 0;
  const tree = await paint(harness.runtime, harness.Component);

  await findButton(tree, t.footerSendTest).props.onClick();
  await flushAsync();
  const after = await paint(harness.runtime, harness.Component);
  assert.ok(strings(after).some((line) => line.includes('row unloaded')));
  assert.equal(findSwitch(after, t.fieldTestOnActivate).props['aria-checked'], 'false');
});

test('wrapped disarm refusal leaves the test switch visibly armed', async () => {
  let calls = 0;
  const harness = mount({
    value: { ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), locale: 'en' },
    update: async (ns, patch) => {
      calls += 1;
      if (calls > 1) return remoteFail('row unloaded');
      return remoteOk(namespace(normalizeConfig({ ...JSON.parse(JSON.stringify(HOST_DEFAULTS)), ...patch }), 4, ns));
    },
  });
  const t = harness.test.STRINGS.en;
  harness.test.TEST_DISARM_DELAY_MS.current = 0;
  let tree = await paint(harness.runtime, harness.Component);

  await findButton(tree, t.footerSendTest).props.onClick();
  await flushAsync();
  tree = await paint(harness.runtime, harness.Component);

  assert.equal(calls, 2, 'both steps were attempted');
  assert.equal(findSwitch(tree, t.fieldTestOnActivate).props['aria-checked'], 'true', 'the switch stays on so the user can turn it off');
  assert.ok(strings(tree).includes(t.statusTestDisarmFailed));
});

test('runTestNotification is pure enough to drive directly', async () => {
  const { runTestNotification } = createModule().exports.__test;
  const seen = [];
  const views = [
    { ns: 'ns', revision: 11, value: { testOnActivate: true } },
    { ns: 'ns', revision: 12, value: { testOnActivate: false } },
  ];
  const result = await runTestNotification({
    update: async (ns, patch, revision) => {
      seen.push({ ns, patch, revision });
      return remoteOk(views[seen.length - 1]);
    },
    ns: 'ns',
    patch: { enabled: true, testOnActivate: false },
    revision: 10,
    delayMs: 0,
  });

  assert.deepEqual(seen.map((call) => call.revision), [10, 11]);
  assert.equal(seen[0].patch.testOnActivate, true);
  assert.deepEqual(seen[1].patch, { testOnActivate: false });
  assert.equal(result.revision, 12);
});
