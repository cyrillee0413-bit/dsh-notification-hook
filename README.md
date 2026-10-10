# Notification & Webhook Hook

[![CI](https://github.com/cyrillee0413-bit/dsh-notification-hook/actions/workflows/ci.yml/badge.svg)](https://github.com/cyrillee0413-bit/dsh-notification-hook/actions/workflows/ci.yml)

A lightweight DeepSeek Harness (DSH) plugin that notifies you when a task completes, fails, or waits for input. It can send native desktop notifications and POST to Feishu, WeCom, Telegram, Discord, Slack, or a generic JSON webhook at the same time.

Version `0.3.0` is tested with DSH `0.2.0-rc.2` and declares compatibility with `>=0.2.0-rc.2 <0.3.0`.

## Dependency policy

Delivery uses only `node:*` modules and local files: no `node-notifier`, HTTP client, UI framework package, build step, or bundler. The only direct runtime dependency is `@deepseek-ai/schemastery`, an official DSH runtime component required for the writable settings namespace. The browser uses the React instance already provided by DSH.

## Notifications

The settings page keeps the three everyday outcomes prominent:

- Completed — `turn/end` with `reason.kind === 'completed'`.
- Failed — `turn/end` with `reason.kind === 'error'`.
- Awaiting input — an open approval, agent question, or blocked turn.

Attention (`max-tokens`) and Cancelled (`aborted` or `interrupted`) remain available under Advanced. All five outcomes remain independently configurable.

Short completed or cancelled turns can be suppressed with `minDurationMs`. Failures and waiting states bypass that threshold. Approval prompts are delayed by `awaitingInputDelayMs` and cancelled when the approval resolves before the delay expires.

## Installation

Prefer an npm registry release or the verified `.tgz`. Both routes let npm/pnpm install the official `@deepseek-ai/schemastery` dependency, so DSH receives the native volatile Config required by the editable settings page:

```powershell
dsh plugin --profile desktop add dsh-notification-hook@0.3.0
dsh plugin --profile desktop add C:\path\to\dsh-notification-hook-0.3.0.tgz
```

A bare `link:` installation is for source development only. Node resolves imports from the linked source realpath; if that source tree has no `node_modules`, Schemastery cannot resolve and the plugin deliberately falls back to its dependency-free schema. Delivery still works, but the settings page may show the recovery generator instead of a writable form. Run `npm ci` in the source directory before linking, or test the generated `.tgz` instead.

After every install, upgrade, removal, or reinstall, restart DeepSeek Harness and refresh the settings page. DSH caches host modules by package name, so replacing files without a restart does not load the new implementation. Open **Settings → Built-in plugins → Notifications**; the editable settings form should appear.

The row id is `notify-hook`. `config.enabled: false` keeps the row loaded but silent; the DSH row or bundle switches can unload it completely.

### DSH compatibility

The peer range is exactly `>=0.2.0-rc.2 <0.3.0`.

| DSH version | Support |
|---|---|
| `0.2.0-rc.2` | fully tested by the release lifecycle |
| later compatible `0.2.0` RCs and stable `0.2.x` | accepted by the peer range; CI pins `0.2.0-rc.2` |
| `0.2.1-alpha.2` | intentionally rejected by npm prerelease tuple rules |
| `0.3.0` and later | rejected until this plugin is retested and publishes a widened peer range |

## Settings page

The normal page reads and writes the live DSH Settings namespace. The `0.3.0` client correctly unwraps DSH Remote results before discovering a namespace or adopting a saved revision. Saving is revision-aware: a conflict keeps the unsaved draft on screen and reports the failure.

The tab label, settings page, and notification text follow DSH's global language setting. There is no separate language switch on this page. DSH's automatic mode follows the operating-system locale. A legacy `config.locale` value remains accepted for older profiles, but is used only when the DSH locale namespace is unavailable.

Main sections:

| Section | Controls |
|---|---|
| Events | Completed, Failed, Awaiting input |
| Desktop | native popup and sound |
| Webhook targets | multiple targets, each independently enabled |
| Advanced | Attention, Cancelled, timing, dedupe, subagents, HTTP and logging |

Webhook URL fields are masked by default and can be revealed one row at a time. Adding or removing a row masks every URL again. UI and browser-console errors redact HTTP(S) URLs before displaying or logging them.

For provider-by-provider instructions, including the exact Telegram URL and Chat ID steps, see the **[notification target setup guide](docs/WEBHOOK-GUIDE.md)**.

### Recovery generator

The YAML generator is an emergency recovery surface, not the expected page for a correctly installed `0.3.0` package. It appears only when the Settings Remote is unavailable, returns malformed data, or exposes no usable `notify-hook` namespace. Expand **Technical diagnostics** there when troubleshooting; restart DSH or reinstall the bundle before editing profile files manually. Developer diagnostics are intentionally absent from the normal settings page.

If recovery is still necessary, tune the controls, copy the complete block, and replace the existing `notify-hook` `config` in the profile's `cordis.patch.yml`. A matching override replaces the whole `config` block, so the generator deliberately emits every field.

## Test notification

**Send test notification** performs two real settings writes:

1. save the current draft with `testOnActivate: true`, causing the host plugin to deliver through every enabled desktop/webhook target;
2. wait briefly and save `testOnActivate: false` using the revision returned by the first write.

If the second write fails, the UI deliberately leaves the switch visibly on and reports that disarming failed. Turn **Test on activate** off manually and Save before another reload.

## Configuration

Every key is optional. This is the recommended shape:

```yaml
- id: notify-hook
  name: dsh-notification-hook
  config:
    enabled: true
    events:
      completed: true
      failed: true
      awaitingInput: true
      attention: true
      cancelled: false
    includeSubagents: false
    minDurationMs: 10000
    awaitingInputDelayMs: 2500
    dedupeWindowMs: 3000
    desktop:
      enabled: true
      sound: false
      appId: ''
      timeoutMs: 10000
    webhooks: []
    timeoutMs: 8000
    retries: 1
    logLevel: info
    logDeliveries: true
    testOnActivate: false
```

### Webhook targets

Create webhook URLs in the provider's administration console and paste them directly into the masked field. Do not put real URLs, bot tokens, authorization headers, or payloads into issues, screenshots, examples, or logs.

```yaml
webhooks:
  - name: team-chat
    enabled: true
    type: auto
    url: <provider webhook URL>

  - name: telegram
    enabled: false
    type: telegram
    url: <Telegram bot endpoint>
    chatId: '<chat id>'

  - name: internal
    type: generic
    url: <HTTPS endpoint>
    headers:
      authorization: <secret value>
```

`type: auto` detects Feishu, WeCom, Telegram, Discord, and Slack from the URL; set `type` explicitly for a generic endpoint. One failed target never blocks the others. Requests use bounded timeouts/retries, do not follow redirects, cap bodies at 64 KiB, and log only redacted target URLs.

### Desktop delivery

| OS | Mechanism |
|---|---|
| Windows | WinRT toast through `powershell.exe`, then `msg.exe` fallback |
| macOS | `osascript` notification |
| Linux | `notify-send` |

Processes are spawned with argument arrays, never through a shell. Session-derived text is escaped for the target platform.

## Development and verification

```powershell
npm ci
npm run check
npm run verify:package -- --out-dir dist
npm run verify:dsh -- --archive-dir dist
node tools/selftest.mjs --no-desktop
node tools/selftest.mjs --desktop-only
npm pack --dry-run --json
```

`verify:package` packs, scans, installs and imports the real candidate archive. `verify:dsh` provisions pinned DSH and pnpm versions in an owned temporary profile, then checks install, file-spec replacement, config composition, removal and reinstall. The loopback self-test never contacts an external service. The desktop-only test intentionally displays three real native notifications.

Maintainers should use [docs/RELEASING.md](docs/RELEASING.md) for the one-time npm bootstrap and normal OIDC release procedure.

## Troubleshooting

| Symptom | Check |
|---|---|
| Recovery generator appears | expand **Technical diagnostics**, restart DSH, then inspect the Remote result |
| Save reports a conflict | keep the draft, refresh/reload the namespace, and save again |
| Test remains armed | switch `testOnActivate` off manually and Save |
| Nothing arrives | inspect redacted `[notify-hook]` delivery summaries and per-target enable switches |
| Fast success is silent | lower `minDurationMs` or set it to `0` |
| Desktop delivery fails | check OS notification permissions and the platform command listed above |

For provider-specific errors such as Telegram Chat IDs or platform webhook permissions, use the **[notification target setup guide](docs/WEBHOOK-GUIDE.md)**.

## License

MIT. See `LICENSE`.
