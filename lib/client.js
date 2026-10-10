/**
 * dsh-notification-hook — browser half.
 *
 * A settings page for the notify-hook host plugin, registered into the
 * `settings.plugins.tab` list slot (one tab inside the Plugins settings section).
 *
 * Served to the browser verbatim: no bundler, no JSX, no `@deepseek-ai/*` import,
 * no `document` access. React arrives through the module table (`require('react')`)
 * and every style is inline and themed with `--dsw-alias-*` variables, so the page
 * follows the Harness light and dark themes without shipping any CSS.
 *
 * The host half owns validation; this half only has to be honest about what it
 * sends. Three rules shape most of the code below:
 *
 * 1. **The component must never throw.** A throwing slot entry is replaced by a
 *    crash notice and the user loses the panel, so namespace discovery, every read
 *    of a server-provided value, the YAML preview and even the final render are
 *    defensive.
 * 2. **Writes are explicit.** Saving is a button, because every successful write
 *    persists the row and re-activates the host plugin.
 * 3. **No live namespace is a normal outcome, not an error.** The Harness only
 *    projects a live settings namespace for a plugin whose `Config` is its own
 *    schemastery schema with a `volatile` field; this plugin is dependency-free on
 *    purpose, so it registers no such schema. The page therefore has two shapes: a
 *    live form when a namespace is found, and a config generator otherwise, which
 *    renders the very same controls and emits a complete `config:` block for the
 *    profile's `cordis.patch.yml`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-notification-hook',
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    /* ------------------------------------------------------------------ *
     * constants
     * ------------------------------------------------------------------ */

    /** Slot this page registers into; owned by the built-in Plugins settings section. */
    const SLOT = 'settings.plugins.tab';
    /** Entry id, i.e. the tab id inside that slot. */
    const ROW_ID = 'notify-hook';
    /** Tab order inside the Plugins page (the section itself is order 15). */
    const TAB_ORDER = 30;
    /** Locale dictionary namespace owned by this client plugin. */
    const LOCALE_NS = 'dsh.notificationHook';

    /**
     * The settings namespace this bundle's host row owns.
     *
     * The settings service keys a namespace by the profile entry's **patch id** — the `id:` of
     * the row in `cordis.patch.yml`, i.e. `ROW_ID` — so that is the primary key. The loader's
     * tree id (`include:<patch id>`) is accepted too, because it is the id the
     * `Config.listConfigs` inspection shows and therefore the one a reader would expect.
     */
    const NS_IDS = [ROW_ID, `include:${ROW_ID}`];

    /** Shown in the collapsed recovery diagnostics when settings discovery fails. */
    const VERSION = '0.3.0';

    /** Keys of `config.events`, in display order. */
    const EVENT_KEYS = ['completed', 'failed', 'awaitingInput', 'attention', 'cancelled'];
    /** Accepted `config.locale` values. */
    const LOCALES = ['auto', 'zh', 'en'];
    /** Accepted `config.logLevel` values. */
    const LOG_LEVELS = ['silent', 'error', 'warn', 'info'];
    /** Accepted webhook `type` values; `auto` sniffs the provider from the URL. */
    const TARGET_TYPES = ['auto', 'feishu', 'wecom', 'telegram', 'discord', 'slack', 'generic'];
    /** Providers offered by the quick-add buttons (the ones users actually paste URLs for). */
    const QUICK_ADD = ['feishu', 'wecom', 'telegram', 'discord', 'slack', 'generic'];

    /** Verbosity presets, exactly as specified: they write `events` and `minDurationMs`. */
    const PRESETS = Object.freeze({
      detailed: Object.freeze({
        events: Object.freeze({ completed: true, failed: true, awaitingInput: true, attention: true, cancelled: true }),
        minDurationMs: 0,
      }),
      balanced: Object.freeze({
        events: Object.freeze({ completed: true, failed: true, awaitingInput: true, attention: true, cancelled: false }),
        minDurationMs: 10000,
      }),
      important: Object.freeze({
        events: Object.freeze({ completed: false, failed: true, awaitingInput: true, attention: true, cancelled: false }),
        minDurationMs: 10000,
      }),
      silent: Object.freeze({
        events: Object.freeze({ completed: false, failed: false, awaitingInput: false, attention: false, cancelled: false }),
        minDurationMs: 10000,
      }),
    });
    const PRESET_KEYS = ['detailed', 'balanced', 'important', 'silent'];

    /**
     * Client-side copy of the editable half of `lib/config.js` `DEFAULTS`.
     *
     * This module cannot import the host file (no bundler, plain browser script), so
     * the values are restated here. `test/client.test.mjs` asserts that every key
     * below still matches the host defaults, so drift is caught by the suite rather
     * than by a user seeing a wrong placeholder.
     *
     * `desktop.appId` and `desktop.timeoutMs` have no control in this UI; they are
     * listed because the generated config block (see `previewConfig`) prints every
     * field, and it needs a value for the two it cannot edit.
     */
    const EDITABLE_DEFAULTS = Object.freeze({
      enabled: true,
      locale: 'auto',
      events: Object.freeze({ completed: true, failed: true, awaitingInput: true, attention: true, cancelled: false }),
      includeSubagents: false,
      minDurationMs: 10000,
      awaitingInputDelayMs: 2500,
      dedupeWindowMs: 3000,
      desktop: Object.freeze({ enabled: true, sound: false, appId: '', timeoutMs: 10000 }),
      webhooks: Object.freeze([]),
      timeoutMs: 8000,
      retries: 1,
      logDeliveries: true,
      logLevel: 'info',
      testOnActivate: false,
    });

    /** `[min, max]` per numeric field, mirroring the clamps in `lib/config.js`. */
    const NUMERIC_LIMITS = Object.freeze({
      minDurationMs: [0, 24 * 60 * 60 * 1000],
      awaitingInputDelayMs: [0, 60000],
      dedupeWindowMs: [0, 60000],
      timeoutMs: [250, 60000],
      retries: [0, 3],
    });

    /**
     * How long the two-step test dance waits before disarming `testOnActivate`.
     *
     * Mutable so the Node-side suite can run the dance without a real timer; the
     * browser always sees 2500.
     */
    const TEST_DISARM_DELAY_MS = { current: 2500 };

    /**
     * Every user-visible string. `en` and `zh` must keep identical keys — the suite
     * asserts it, because a missing key is a blank label in one language.
     */
    const STRINGS = Object.freeze({
      en: Object.freeze({
        tabLabel: 'Notifications',
        title: 'Notifications & webhooks',
        masterLabel: 'Enable notifications',
        statusDisabled: 'Notifications are off',
        statusDesktopOn: 'Desktop notifications on',
        statusDesktopOff: 'Desktop notifications off',
        targetsNone: 'no webhook targets',
        targetsOne: '1 webhook target',
        targetsMany: '{n} webhook targets',

        secVerbosity: 'How much to notify',
        verbosityHint: 'A preset only sets the event switches and the minimum duration; you can fine-tune both below.',
        presetDetailed: 'Everything',
        presetDetailedHint: 'Every outcome, however short the run.',
        presetBalanced: 'Balanced',
        presetBalancedHint: 'Skip cancelled runs and anything under 10 s.',
        presetImportant: 'Important only',
        presetImportantHint: 'Failures and the moments that wait for you.',
        presetSilent: 'Silent',
        presetSilentHint: 'Never notify, but keep this configuration for later.',
        presetCustom: 'Custom',
        presetCustomHint: 'A custom mix: the switches below no longer match any preset.',

        secEvents: 'Events',
        eventsHint: 'Failures and waiting states always notify, however short the run.',
        evCompleted: 'Completed',
        evCompletedHint: 'The turn finished successfully.',
        evFailed: 'Failed',
        evAwaitingInput: 'Waiting for me',
        evAwaitingInputHint: 'A permission prompt or a question is open.',
        evAttention: 'Needs attention',
        evCancelled: 'Cancelled',
        evCancelledHint: 'You stopped the turn yourself.',

        secDesktop: 'Desktop notifications',
        desktopEnabled: 'Show a desktop notification',
        desktopSound: 'Play a sound',
        desktopHint: 'Uses the notification centre of the operating system.',

        secTargets: 'Webhook targets',
        targetsHint: 'Every target has its own switch: keep a channel configured and stay quiet on it, or push to several at once.',
        targetsEmpty: 'No targets yet. Add one to push notifications to your phone or your team chat.',
        targetEnabled: 'Deliver to this target',
        targetName: 'Name',
        targetNamePlaceholder: 'team chat',
        targetType: 'Type',
        targetUrl: 'Webhook URL',
        targetUrlPlaceholder: 'https://…',
        targetReveal: 'Reveal',
        targetHide: 'Hide',
        targetChatId: 'Chat ID',
        targetChatIdPlaceholder: '123456789',
        targetRemove: 'Remove',
        targetAdd: 'Add target',
        quickAdd: 'Quick add:',
        typeAuto: 'Auto-detect',
        typeFeishu: 'Feishu',
        typeWecom: 'WeCom',
        typeTelegram: 'Telegram',
        typeDiscord: 'Discord',
        typeSlack: 'Slack',
        typeGeneric: 'Custom JSON',
        typeUnknown: 'Unknown type “{type}” — the plugin refuses this target until it is fixed',
        detectedPrefix: 'Detected: {provider}',
        urlMissing: 'A URL is required.',
        urlInvalid: 'Must start with http:// or https://',
        rowDisabledHint: 'Switched off: saved with the others, never delivered to.',

        secAdvanced: 'Advanced',
        fieldMinDuration: 'Ignore runs shorter than',
        fieldAwaitingDelay: 'Wait before “needs you”',
        fieldDedupeWindow: 'Collapse repeats within',
        fieldTimeout: 'Request timeout',
        fieldRetries: 'Retries',
        fieldLogLevel: 'Log level',
        fieldIncludeSubagents: 'Include subagent sessions',
        fieldIncludeSubagentsHint: 'A delegated run is chatty; off by default.',
        fieldLogDeliveries: 'Log every delivery',
        fieldLogDeliveriesHint: 'One line per attempt in the host log.',
        fieldTestOnActivate: 'Send a test notification on activation',
        fieldTestOnActivateHint: 'This fires again on every reload, so switch it back off when you are done.',
        unitMs: 'ms',
        levelSilent: 'Silent',
        levelError: 'Errors',
        levelWarn: 'Warnings',
        levelInfo: 'Info',

        footerSave: 'Save',
        footerReloadLatest: 'Reload latest & keep edits',
        footerSendTest: 'Send test notification',
        footerSendTestHint: 'Saves this form first, then asks the plugin to send one real notification through every enabled target.',
        statusLoading: 'Loading…',
        statusUnsaved: 'Unsaved changes',
        statusSaved: 'Saved',
        statusSaving: 'Saving…',
        statusRefreshing: 'Reloading the latest settings…',
        statusRebased: 'Latest settings loaded; your edits are still unsaved.',
        statusSaveFailed: 'Could not save: {message}',
        statusTesting: 'Sending a test notification…',
        statusTestSent: 'Test sent — check your desktop and your targets.',
        statusTestFailed: 'Test failed: {message}',
        statusTestDisarmFailed: 'The test was sent, but switching it back off failed. Turn the switch off below.',
        fixRowsFirst: 'Fix the highlighted targets first.',
        technicalDetails: 'Technical diagnostics',

        genTitle: 'No live settings form — and that is expected',
        genNote: 'The Harness projects a live settings form only for plugins whose Config is a native schema with a volatile field. This bundle declares one, but its schema-library dependency did not resolve in this installation, so it fell back to a dependency-free schema the settings service cannot project. The plugin itself keeps running normally — this page generates the configuration for you to paste instead of writing it.',
        genErrorPrefix: 'The settings service could not be read: {message}',
        genRetry: 'Check again',
        genPreviewTitle: 'Configuration to paste',
        genPreviewHint: 'Regenerated from the controls above as you change them. Every field is listed, because an override replaces the whole config: block.',
        genCopy: 'Copy',
        genCopied: 'Copied',
        genRevealSecrets: 'Reveal generated secrets',
        genHideSecrets: 'Hide generated secrets',
        genSecretsHint: 'Webhook URLs and header values are hidden in the preview. Copy still uses the complete configuration.',
        genManualHint: 'This browser will not let the page copy for you. Select the text below and copy it with Ctrl+C (⌘C on a Mac).',
        genPasteTitle: 'Where this goes',
        genPasteWhere: 'Open the cordis.patch.yml of this profile, find the notify-hook row and make its config: block exactly this:',
        genPasteCopy: 'Copy the whole row',
        genPasteLayer: 'cordis.patch.yml is the profile’s user patch layer. It is applied after the bundle layers, so what you write there wins.',
        genPasteReplaces: 'A matching override replaces the entire config: block, so a field left out would drop back to its default — which is why the preview above prints all of them.',
        genPasteReload: 'The new configuration is picked up on the next config reload.',
        genPasteDefaults: 'The two desktop fields this page does not edit (appId and desktop.timeoutMs) are printed with their defaults; edit them in the pasted block if you had set them by hand.',
      }),
      zh: Object.freeze({
        tabLabel: '任务提醒',
        title: '通知与推送',
        masterLabel: '启用通知',
        statusDisabled: '通知已关闭',
        statusDesktopOn: '桌面通知已开启',
        statusDesktopOff: '桌面通知已关闭',
        targetsNone: '暂无推送目标',
        targetsOne: '1 个推送目标',
        targetsMany: '{n} 个推送目标',

        secVerbosity: '提醒强度',
        verbosityHint: '预设只调整下方的事件开关与最短时长，之后仍可逐项微调。',
        presetDetailed: '全部提醒',
        presetDetailedHint: '任何结果都提醒，再短的对话也不放过。',
        presetBalanced: '均衡',
        presetBalancedHint: '忽略被取消的对话，以及 10 秒内结束的任务。',
        presetImportant: '只提醒重要的',
        presetImportantHint: '只在失败、或需要你处理时提醒。',
        presetSilent: '静默',
        presetSilentHint: '完全不提醒，但保留这份配置备用。',
        presetCustom: '自定义',
        presetCustomHint: '自定义组合：下方开关已不再对应任何预设。',

        secEvents: '事件细项',
        eventsHint: '失败与等待类事件无论耗时长短都会提醒。',
        evCompleted: '已完成',
        evCompletedHint: '这一轮顺利完成。',
        evFailed: '失败',
        evAwaitingInput: '等待我的输入',
        evAwaitingInputHint: '有权限确认或问题正等着你回答。',
        evAttention: '需要关注',
        evCancelled: '已取消',
        evCancelledHint: '你自己中断了这一轮。',

        secDesktop: '桌面通知',
        desktopEnabled: '弹出桌面通知',
        desktopSound: '播放提示音',
        desktopHint: '使用操作系统自带的通知中心。',

        secTargets: '推送目标',
        targetsHint: '每个目标都有独立开关：可以保留配置但暂时不推，也可以同时推送到多个渠道。',
        targetsEmpty: '还没有推送目标。添加一个，就能把通知推到手机或群里。',
        targetEnabled: '推送到该目标',
        targetName: '名称',
        targetNamePlaceholder: '项目群',
        targetType: '类型',
        targetUrl: 'Webhook 地址',
        targetUrlPlaceholder: 'https://…',
        targetReveal: '显示',
        targetHide: '隐藏',
        targetChatId: '会话 ID',
        targetChatIdPlaceholder: '123456789',
        targetRemove: '删除',
        targetAdd: '添加目标',
        quickAdd: '快速添加：',
        typeAuto: '自动识别',
        typeFeishu: '飞书',
        typeWecom: '企业微信',
        typeTelegram: 'Telegram',
        typeDiscord: 'Discord',
        typeSlack: 'Slack',
        typeGeneric: '自定义 JSON',
        typeUnknown: '未知类型“{type}”——修好之前插件会拒绝这个目标',
        detectedPrefix: '识别为：{provider}',
        urlMissing: '请填写 Webhook 地址。',
        urlInvalid: '必须以 http:// 或 https:// 开头',
        rowDisabledHint: '已关闭：会随其他目标一起保存，但不会向它推送。',

        secAdvanced: '高级',
        fieldMinDuration: '忽略短于该时长的任务',
        fieldAwaitingDelay: '“需要你”提醒的延迟',
        fieldDedupeWindow: '重复提醒的合并窗口',
        fieldTimeout: '请求超时',
        fieldRetries: '重试次数',
        fieldLogLevel: '日志级别',
        fieldIncludeSubagents: '包含子代理会话',
        fieldIncludeSubagentsHint: '子代理很吵，默认不提醒。',
        fieldLogDeliveries: '记录每次推送',
        fieldLogDeliveriesHint: '每尝试一次就在宿主日志里写一行。',
        fieldTestOnActivate: '激活时发送一条测试通知',
        fieldTestOnActivateHint: '插件每次重新加载都会再发一次，用完后记得关掉。',
        unitMs: '毫秒',
        levelSilent: '静默',
        levelError: '仅错误',
        levelWarn: '警告',
        levelInfo: '常规',

        footerSave: '保存',
        footerReloadLatest: '重新读取并保留本地修改',
        footerSendTest: '发送测试通知',
        footerSendTestHint: '先保存当前表单，再让插件通过所有已启用的目标真实发送一条通知。',
        statusLoading: '正在加载…',
        statusUnsaved: '有未保存的改动',
        statusSaved: '已保存',
        statusSaving: '正在保存…',
        statusRefreshing: '正在读取最新设置…',
        statusRebased: '已读取最新设置，你的本地修改仍未保存。',
        statusSaveFailed: '保存失败：{message}',
        statusTesting: '正在发送测试通知…',
        statusTestSent: '测试通知已发送，请查看桌面和推送目标。',
        statusTestFailed: '测试失败：{message}',
        statusTestDisarmFailed: '测试已发送，但关闭测试开关失败，请在下方手动关闭。',
        fixRowsFirst: '请先修正标红的推送目标。',
        technicalDetails: '技术诊断信息',

        genTitle: '这里没有实时设置表单——这是正常的',
        genNote: '宿主只为“Config 是原生 schema、且带 volatile 字段”的插件提供实时设置表单。本插件确实声明了这样的 schema，但它的 schema 库依赖在这次安装里没有解析到，于是退回了设置服务无法投影的零依赖 schema。插件本身照常运行——这个页面改为生成配置交给你粘贴，而不是直接替你写入。',
        genErrorPrefix: '读取设置服务失败：{message}',
        genRetry: '重新检查',
        genPreviewTitle: '待粘贴的配置',
        genPreviewHint: '随上方控件实时重新生成。这里会列出全部字段，因为覆盖项会整体替换 config: 块。',
        genCopy: '复制',
        genCopied: '已复制',
        genRevealSecrets: '显示生成内容中的密钥',
        genHideSecrets: '隐藏生成内容中的密钥',
        genSecretsHint: '预览中会隐藏 Webhook 地址和请求头值；复制时仍会使用完整配置。',
        genManualHint: '当前浏览器不允许页面代为复制。请选中下面的文本，用 Ctrl+C（macOS 为 ⌘C）复制。',
        genPasteTitle: '粘贴到哪里',
        genPasteWhere: '打开该 profile 的 cordis.patch.yml，找到 notify-hook 一行，把它的 config: 块改成下面这样：',
        genPasteCopy: '复制整行',
        genPasteLayer: 'cordis.patch.yml 是该 profile 的用户补丁层，在 bundle 层之后应用，因此你写进去的内容优先级更高。',
        genPasteReplaces: '匹配到的覆盖项会整体替换 config: 块，少写一个字段就会退回默认值——所以上面的预览会列出全部字段。',
        genPasteReload: '新的配置会在下一次配置重新加载时生效。',
        genPasteDefaults: '本页不编辑的两个桌面字段（appId 与 desktop.timeoutMs）会按默认值输出；如果你之前手动设置过，请在粘贴后自行修改。',
      }),
    });

    /* ------------------------------------------------------------------ *
     * primitives
     * ------------------------------------------------------------------ */

    /** @param {unknown} value @returns {value is Record<string, any>} */
    function isObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /** @param {unknown} value @returns {string} the value when it is a string, else `''`. */
    function text(value) {
      return typeof value === 'string' ? value : '';
    }

    /** Best-effort human message for anything a promise can reject with. */
    function messageOf(error) {
      try {
        if (error === null || error === undefined) return '';
        if (typeof error === 'string') return error.slice(0, 300);
        if (typeof error.message === 'string' && error.message) return error.message.slice(0, 300);
        return String(error).slice(0, 300);
      } catch {
        return '';
      }
    }

    /** User-visible/log-safe message: never echo a credential-bearing URL. */
    function sanitizeUiMessage(value) {
      return messageOf(value).replace(/https?:\/\/\S+/gi, '[redacted URL]').slice(0, 300);
    }

    /** JSON-shaped equality for the plain data used by settings drafts. */
    function sameValue(left, right) {
      try {
        return JSON.stringify(left) === JSON.stringify(right);
      } catch {
        return Object.is(left, right);
      }
    }

    /**
     * Three-way merge for conflict recovery. Locally edited leaves win; untouched
     * leaves adopt the newest server value. Arrays are atomic because webhook rows
     * have no stable server-side identity.
     */
    function rebaseDraft(current, base, latest) {
      if (sameValue(current, base)) return latest;
      if (!isObject(current) || !isObject(base) || !isObject(latest)) return current;
      const out = {};
      const keys = new Set([...Object.keys(base), ...Object.keys(latest), ...Object.keys(current)]);
      for (const key of keys) out[key] = rebaseDraft(current[key], base[key], latest[key]);
      return out;
    }

    /**
     * Unwrap the result envelope used by DSH Remote calls.
     *
     * Reject malformed responses instead of treating them as empty data: opening a
     * write surface from an invented configuration would be worse than showing the
     * recovery generator. Remote failure details are reduced to their human message;
     * the full response may contain credentials and is never serialized here.
     */
    function unwrapRemoteResult(response, operation) {
      const name = text(operation) || 'Remote operation';
      if (!isObject(response) || typeof response.ok !== 'boolean') {
        throw new Error(`${name} returned a malformed Remote response`);
      }
      if (response.ok === false) {
        const detail = isObject(response.error) ? messageOf(response.error.message) : '';
        throw new Error(detail ? `${name} failed: ${detail}` : `${name} failed`);
      }
      if (!Object.prototype.hasOwnProperty.call(response, 'value')) {
        throw new Error(`${name} returned a malformed Remote response`);
      }
      return response.value;
    }

    /** Never-throwing diagnostics; a failed log must not break a render. */
    function warn(message, error) {
      try {
        if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
          console.warn(`[dsh-notification-hook] ${message}`, error);
        }
      } catch {
        /* diagnostics only */
      }
    }

    /**
     * The same sink as {@link warn}, at error level.
     *
     * Used where the failure is user-visible rather than a degraded-but-working path.
     * The browser console is the only place such a failure can be diagnosed: the slot
     * owner replaces a crashed entry with an empty element, and a registration that
     * was never made leaves no trace in the DOM at all.
     */
    function logError(message, error) {
      try {
        if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
          console.error(`[dsh-notification-hook] ${message}`, error);
        }
      } catch {
        /* diagnostics only */
      }
    }

    /** `{name}` substitution; unknown placeholders are left alone. */
    function fmt(template, values) {
      const source = text(template);
      if (!source) return '';
      return source.replace(/\{(\w+)\}/g, (match, key) => (
        isObject(values) && key in values ? String(values[key]) : match
      ));
    }

    /** Truncating, clamping numeric coercion that mirrors `lib/config.js`'s behaviour. */
    function coerceNumber(value, fallback, min, max) {
      let candidate = NaN;
      if (typeof value === 'number') candidate = value;
      else if (typeof value === 'string' && value.trim()) candidate = Number(value.trim());
      if (!Number.isFinite(candidate)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(candidate)));
    }

    /** Render a numeric config value as the text a number input can hold. */
    function numberText(value, fallback) {
      if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
      return String(fallback);
    }

    /** Clamp a draft field through its declared limits. */
    function clampField(field, value) {
      const limits = NUMERIC_LIMITS[field] || [0, 0];
      return coerceNumber(value, EDITABLE_DEFAULTS[field], limits[0], limits[1]);
    }

    /** Current browser language tag, or `null` outside a browser. */
    function navigatorObject() {
      try {
        return typeof navigator !== 'undefined' && navigator ? navigator : null;
      } catch {
        return null;
      }
    }

    /** Resolve every client string through DSH's official locale service. */
    function localeStrings(locale) {
      const translate = locale.bind(LOCALE_NS);
      const out = {};
      for (const key of Object.keys(STRINGS.en)) out[key] = translate(key);
      return out;
    }

    /* ------------------------------------------------------------------ *
     * provider detection (display mirror of lib/payloads.js)
     * ------------------------------------------------------------------ */

    /**
     * Sniff the provider from a webhook URL, mirroring `lib/payloads.js`
     * `detectTargetType` exactly — including its path heuristics, so the label shown
     * next to an `auto` target is the provider the host will actually deliver as.
     * Anything unparseable or unrecognised is `generic`.
     */
    function detectTargetType(url) {
      const raw = text(url).trim();
      if (!raw) return 'generic';
      let parsed;
      try {
        parsed = new URL(raw);
      } catch {
        return 'generic';
      }
      const host = String(parsed.hostname || '').toLowerCase();
      const path = String(parsed.pathname || '').toLowerCase();
      const onHost = (suffix) => host === suffix || host.endsWith(`.${suffix}`);

      if (onHost('telegram.org')) return 'telegram';
      if (onHost('weixin.qq.com') || path.includes('/cgi-bin/webhook/')) return 'wecom';
      if (host.includes('feishu') || path.includes('/open-apis/bot/')) return 'feishu';
      if (onHost('discord.com') || onHost('discordapp.com') || path.includes('/api/webhooks/')) return 'discord';
      if (onHost('hooks.slack.com') || (onHost('slack.com') && path.includes('/services/'))) return 'slack';
      return 'generic';
    }

    /**
     * The provider a row will actually be delivered as, mirroring `lib/payloads.js`
     * `resolveType`: an absent, empty or `auto` type is sniffed from the URL, and a
     * non-string type is treated as absent (the host normalizer does the same).
     *
     * An explicit type this build does not know is returned *as itself* rather than
     * sniffed: the host refuses to deliver an unknown explicit type (`PayloadError`,
     * "a config error, not a runtime failure"), so showing the row as a healthy
     * sniffed target would be a claim the next Save would make come true.
     */
    function targetTypeOf(row) {
      const source = isObject(row) ? row : {};
      const type = text(source.type).trim().toLowerCase();
      if (!type || type === 'auto') return detectTargetType(source.url);
      return type;
    }

    /* ------------------------------------------------------------------ *
     * verbosity presets
     * ------------------------------------------------------------------ */

    /**
     * Which preset a pair of `events` / `minDurationMs` values corresponds to, or
     * `'custom'` when the user has moved away from all four.
     */
    function presetFor(events, minDurationMs) {
      const map = isObject(events) ? events : {};
      const duration = coerceNumber(minDurationMs, NaN, 0, Number.MAX_SAFE_INTEGER);
      for (const key of PRESET_KEYS) {
        const preset = PRESETS[key];
        if (duration !== preset.minDurationMs) continue;
        if (EVENT_KEYS.every((eventKey) => (map[eventKey] === true) === preset.events[eventKey])) return key;
      }
      return 'custom';
    }

    /* ------------------------------------------------------------------ *
     * draft <-> config projection
     * ------------------------------------------------------------------ */

    /**
     * Build the local draft from a live config value.
     *
     * Numeric fields become strings because that is what a number input holds: a
     * user clearing a field mid-edit must not be rewritten to `0` under their
     * cursor. Values are coerced back on save.
     */
    function draftFromValue(value) {
      const source = isObject(value) ? value : {};
      const events = isObject(source.events) ? source.events : {};
      const desktop = isObject(source.desktop) ? source.desktop : {};
      const rows = Array.isArray(source.webhooks) ? source.webhooks : [];
      // Both identifier options are matched the way `lib/config.js` now matches them
      // (trim + lower case), so the panel shows exactly the spelling the host stores and
      // a Save can never rewrite a value the host already accepted.
      const logLevel = text(source.logLevel).trim().toLowerCase();
      const locale = text(source.locale).trim().toLowerCase();

      /** @type {Record<string, boolean>} */
      const eventDraft = {};
      for (const key of EVENT_KEYS) {
        eventDraft[key] = typeof events[key] === 'boolean' ? events[key] : EDITABLE_DEFAULTS.events[key];
      }

      return {
        enabled: typeof source.enabled === 'boolean' ? source.enabled : EDITABLE_DEFAULTS.enabled,
        locale: LOCALES.includes(locale) ? locale : EDITABLE_DEFAULTS.locale,
        events: eventDraft,
        includeSubagents: typeof source.includeSubagents === 'boolean' ? source.includeSubagents : EDITABLE_DEFAULTS.includeSubagents,
        minDurationMs: numberText(source.minDurationMs, EDITABLE_DEFAULTS.minDurationMs),
        awaitingInputDelayMs: numberText(source.awaitingInputDelayMs, EDITABLE_DEFAULTS.awaitingInputDelayMs),
        dedupeWindowMs: numberText(source.dedupeWindowMs, EDITABLE_DEFAULTS.dedupeWindowMs),
        desktop: {
          enabled: typeof desktop.enabled === 'boolean' ? desktop.enabled : EDITABLE_DEFAULTS.desktop.enabled,
          sound: typeof desktop.sound === 'boolean' ? desktop.sound : EDITABLE_DEFAULTS.desktop.sound,
        },
        webhooks: rows.map(rowFromValue),
        timeoutMs: numberText(source.timeoutMs, EDITABLE_DEFAULTS.timeoutMs),
        retries: numberText(source.retries, EDITABLE_DEFAULTS.retries),
        logDeliveries: typeof source.logDeliveries === 'boolean' ? source.logDeliveries : EDITABLE_DEFAULTS.logDeliveries,
        logLevel: LOG_LEVELS.includes(logLevel) ? logLevel : EDITABLE_DEFAULTS.logLevel,
        testOnActivate: typeof source.testOnActivate === 'boolean' ? source.testOnActivate : EDITABLE_DEFAULTS.testOnActivate,
      };
    }

    /**
     * One webhook draft row.
     *
     * `keep` carries every field this UI does not edit (`headers`, per-target
     * `events`, …) so a round-trip through the form cannot silently drop them.
     */
    function rowFromValue(raw) {
      const source = isObject(raw) ? raw : {};
      const type = text(source.type).trim().toLowerCase();
      /** @type {Record<string, unknown>} */
      const keep = {};
      for (const [key, value] of Object.entries(source)) {
        if (key === 'name' || key === 'type' || key === 'url' || key === 'chatId' || key === 'enabled') continue;
        keep[key] = value;
      }
      const chatId = source.chatId;
      return {
        enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
        name: text(source.name),
        // A known type stays itself, and so does an *unknown* one, verbatim. Rewriting
        // an unknown type to `auto` was a silent config rewrite: the host loudly
        // refuses such a target (`lib/payloads.js` throws `PayloadError`), and the next
        // Save turned that refusal into live delivery. A blank type still means "sniff
        // it", which is the host's own default.
        type: TARGET_TYPES.includes(type) ? type : (type || 'auto'),
        url: text(source.url),
        chatId: chatId === undefined || chatId === null ? '' : String(chatId),
        keep,
      };
    }

    /** A brand-new target row, optionally pre-labelled for a provider. */
    function newRow(provider, label) {
      const type = TARGET_TYPES.includes(provider) ? provider : 'auto';
      return { enabled: true, name: text(label), type, url: '', chatId: '', keep: {} };
    }

    /** Serialise one draft row back into a host webhook entry. */
    function rowToPatch(row) {
      const source = isObject(row) ? row : {};
      /** @type {Record<string, unknown>} */
      const out = {};
      if (isObject(source.keep)) {
        for (const [key, value] of Object.entries(source.keep)) out[key] = value;
      }
      out.enabled = source.enabled !== false;
      out.name = text(source.name).trim();
      // Known or unknown, the row's own type goes back unchanged; only a blank type
      // falls back to `auto`. An unknown type must survive the round-trip so the host
      // keeps refusing the target instead of silently starting to deliver to it.
      out.type = text(source.type).trim() || 'auto';
      out.url = text(source.url).trim();
      const chatId = text(source.chatId).trim();
      if (chatId) out.chatId = chatId;
      return out;
    }

    /**
     * The exact patch sent to the host for a draft.
     *
     * `base` is the last adopted config value; it supplies the untouched members of
     * `desktop` so a top-level merge cannot drop `appId` or `desktop.timeoutMs`.
     * Called without `base` it is a pure function of the draft, which is what the
     * dirty check compares.
     */
    function patchOf(draft, base) {
      const source = isObject(draft) ? draft : {};
      const baseValue = isObject(base) ? base : {};
      const desktopBase = isObject(baseValue.desktop) ? baseValue.desktop : {};
      const events = isObject(source.events) ? source.events : {};
      const desktop = isObject(source.desktop) ? source.desktop : {};
      const rows = Array.isArray(source.webhooks) ? source.webhooks : [];

      /** @type {Record<string, boolean>} */
      const eventPatch = {};
      for (const key of EVENT_KEYS) eventPatch[key] = events[key] === true;

      return {
        enabled: source.enabled === true,
        locale: LOCALES.includes(text(source.locale)) ? text(source.locale) : EDITABLE_DEFAULTS.locale,
        events: eventPatch,
        minDurationMs: clampField('minDurationMs', source.minDurationMs),
        awaitingInputDelayMs: clampField('awaitingInputDelayMs', source.awaitingInputDelayMs),
        dedupeWindowMs: clampField('dedupeWindowMs', source.dedupeWindowMs),
        includeSubagents: source.includeSubagents === true,
        desktop: {
          ...desktopBase,
          enabled: desktop.enabled !== false,
          sound: desktop.sound === true,
        },
        webhooks: rows.map(rowToPatch),
        timeoutMs: clampField('timeoutMs', source.timeoutMs),
        retries: clampField('retries', source.retries),
        logDeliveries: source.logDeliveries !== false,
        logLevel: LOG_LEVELS.includes(text(source.logLevel)) ? text(source.logLevel) : EDITABLE_DEFAULTS.logLevel,
        testOnActivate: source.testOnActivate === true,
      };
    }

    /**
     * Why a target row cannot be saved, or `null`.
     *
     * Only enabled rows block the form: the host drops an entry without a usable
     * URL, so an off row that is still being typed is simply not saved yet.
     */
    function rowProblem(row) {
      if (!isObject(row) || row.enabled === false) return null;
      const url = text(row.url).trim();
      if (!url) return 'missing';
      return /^https?:\/\//i.test(url) ? null : 'scheme';
    }

    /** True when saving would change anything the user can edit. */
    function isDirty(draft, adopted) {
      if (!isObject(draft) || !isObject(adopted)) return false;
      try {
        return JSON.stringify(patchOf(draft, null)) !== JSON.stringify(patchOf(draftFromValue(adopted), null));
      } catch (error) {
        warn('dirty check failed', error);
        return true;
      }
    }

    /* ------------------------------------------------------------------ *
     * config generator: YAML emission
     *
     * When the settings service offers no live namespace — the expected case for a
     * dependency-free plugin — the panel cannot write anything, so it hands the user a
     * `config:` block to paste into the profile's `cordis.patch.yml` instead. YAML is
     * emitted here because the harness reads that file as YAML.
     *
     * The emitter below is written for the shape this config has (maps, sequences of
     * maps, strings, numbers, booleans) and is deliberately conservative: a string is
     * quoted whenever a YAML reader could read it as something else — `:` and `#`
     * anywhere, a leading or trailing space, a quote or a backslash, an indicator
     * character in front, or a spelling that looks like a number, a boolean or a null.
     * Webhook URLs contain `://` and chat ids are digit strings, so both rules earn
     * their keep on the first target a user adds.
     * ------------------------------------------------------------------ */

    /**
     * Words a YAML reader resolves to a boolean, a null or an infinity rather than to a
     * string. The dotted spellings (`.inf`, `.nan`) are YAML's own float words and are
     * just as easy to hit with a header value as `true` is.
     */
    const YAML_WORDS = Object.freeze([
      'true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n',
      'null', '~', 'nan', 'inf', '-inf', '.nan', '.inf', '-.inf', '+.inf',
    ]);

    /** Characters that end a plain scalar (or need escaping inside one). */
    const PLAIN_UNSAFE = /["'#\\:\u0000-\u001f\u007f]/;

    /** Characters a plain scalar may not start with; `-` is listed last on purpose. */
    const PLAIN_UNSAFE_START = /^[?:,\[\]{}#&*!|>'"%@`\s-]/;

    /** Longest nesting the emitter walks before it gives up on a value. */
    const YAML_MAX_DEPTH = 16;

    /** True when a YAML reader would resolve a plain spelling as a number. */
    function numberLike(value) {
      return /^[+-]?(?:\d[\d_]*)(?:\.[\d_]*)?(?:[eE][+-]?\d+)?$/.test(value)
        || /^[+-]?\.\d[\d_]*$/.test(value)
        || /^[+-]?0[xob][0-9a-fA-F_]+$/.test(value);
    }

    /** True when a string cannot be written as a YAML plain scalar without changing meaning. */
    function needsQuotes(value) {
      if (value === '') return true;
      if (PLAIN_UNSAFE.test(value)) return true;
      if (PLAIN_UNSAFE_START.test(value)) return true;
      if (value !== value.trim()) return true;
      if (YAML_WORDS.includes(value.toLowerCase())) return true;
      return numberLike(value);
    }

    /** A double-quoted YAML scalar: `"` and `\` escaped, control characters escaped. */
    function quoteYaml(value) {
      let out = '"';
      for (const char of value) {
        if (char === '"') out += '\\"';
        else if (char === '\\') out += '\\\\';
        else if (char === '\n') out += '\\n';
        else if (char === '\r') out += '\\r';
        else if (char === '\t') out += '\\t';
        else {
          const code = char.codePointAt(0);
          out += code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : char;
        }
      }
      return `${out}"`;
    }

    /** One leaf value as YAML. `null` and `undefined` both read back as "no value". */
    function yamlScalar(value) {
      if (value === null || value === undefined) return 'null';
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : quoteYaml(String(value));
      if (typeof value === 'string') {
        if (value === '') return "''";
        return needsQuotes(value) ? quoteYaml(value) : value;
      }
      return quoteYaml(String(value));
    }

    /** A key stays plain whenever it safely can; a pathological name is quoted. */
    function yamlKey(key) {
      const name = String(key);
      const plain = name !== ''
        && name === name.trim()
        && !PLAIN_UNSAFE.test(name)
        && !PLAIN_UNSAFE_START.test(name);
      return plain ? name : quoteYaml(name);
    }

    /** The entries of a map, without the ones that carry no value. */
    function yamlEntries(value) {
      return isObject(value) ? Object.entries(value).filter(([, item]) => item !== undefined) : [];
    }

    /** The items of a sequence, without the ones that carry no value. */
    function yamlItems(value) {
      return Array.isArray(value) ? value.filter((item) => item !== undefined) : [];
    }

    /**
     * YAML lines for a map or a sequence, indented by `indent` spaces.
     *
     * A sequence item is written as `- ` followed by the first line of the item at the
     * same column as the rest of that item, so a map inside a sequence keeps one
     * indentation level and stays readable.
     */
    function emitBlock(value, indent, depth) {
      if (depth > YAML_MAX_DEPTH) throw new TypeError('value is too deep (or cyclic) to render as YAML');
      const pad = ' '.repeat(indent);
      const lines = [];

      if (Array.isArray(value)) {
        for (const item of yamlItems(value)) {
          if (isObject(item) || Array.isArray(item)) {
            const nested = emitBlock(item, indent + 2, depth + 1);
            lines.push(`${pad}- ${nested[0].slice(indent + 2)}`);
            for (const line of nested.slice(1)) lines.push(line);
          } else {
            lines.push(`${pad}- ${yamlScalar(item)}`);
          }
        }
        return lines;
      }

      for (const [key, item] of yamlEntries(value)) {
        const name = yamlKey(key);
        if (isObject(item)) {
          if (!yamlEntries(item).length) { lines.push(`${pad}${name}: {}`); continue; }
          lines.push(`${pad}${name}:`);
          lines.push(...emitBlock(item, indent + 2, depth + 1));
          continue;
        }
        if (Array.isArray(item)) {
          if (!yamlItems(item).length) { lines.push(`${pad}${name}: []`); continue; }
          lines.push(`${pad}${name}:`);
          lines.push(...emitBlock(item, indent + 2, depth + 1));
          continue;
        }
        lines.push(`${pad}${name}: ${yamlScalar(item)}`);
      }
      return lines;
    }

    /**
     * A value as a YAML block.
     *
     * Throws only for a value nesting deeper than {@link YAML_MAX_DEPTH} (a cyclic one
     * included); every caller goes through {@link safeYaml}, so a hostile draft
     * degrades to an empty preview instead of blanking the settings page.
     */
    function toYaml(value) {
      const lines = isObject(value) || Array.isArray(value) ? emitBlock(value, 0, 0) : [yamlScalar(value)];
      if (lines.length) return lines.join('\n');
      return Array.isArray(value) ? '[]' : '{}';
    }

    /**
     * One generated webhook row, in the order the panel lays the row out.
     *
     * The patch keeps whatever the UI does not edit (`headers`, a per-target `events`
     * map) — those follow the known keys, so the block reads the way the form does. A
     * field with no value is dropped here as well, because an emitted `undefined` would
     * be a YAML null and would overwrite the host default.
     */
    function previewRow(row) {
      const source = isObject(row) ? row : {};
      const out = {};
      for (const key of ['enabled', 'name', 'type', 'url', 'chatId']) {
        if (source[key] !== undefined) out[key] = source[key];
      }
      for (const [key, value] of Object.entries(source)) {
        if (value === undefined || key in out) continue;
        out[key] = value;
      }
      return out;
    }

    /**
     * The complete `config` block for a draft.
     *
     * Every field the host accepts is present, in the order `lib/config.js` declares
     * them, because a matching override in `cordis.patch.yml` *replaces* the row's
     * whole `config` block rather than merging into it: a field left out would silently
     * fall back to its default. `base` is the live value the draft came from, and only
     * supplies the two desktop fields this UI has no control for.
     */
    function previewConfig(draft, base) {
      const patch = patchOf(draft, base);
      const desktopBase = isObject(base) && isObject(base.desktop) ? base.desktop : {};
      return {
        enabled: patch.enabled,
        locale: patch.locale,
        events: patch.events,
        includeSubagents: patch.includeSubagents,
        minDurationMs: patch.minDurationMs,
        awaitingInputDelayMs: patch.awaitingInputDelayMs,
        dedupeWindowMs: patch.dedupeWindowMs,
        desktop: {
          enabled: patch.desktop.enabled,
          sound: patch.desktop.sound,
          appId: typeof desktopBase.appId === 'string' ? desktopBase.appId : EDITABLE_DEFAULTS.desktop.appId,
          timeoutMs: coerceNumber(desktopBase.timeoutMs, EDITABLE_DEFAULTS.desktop.timeoutMs, 500, 60000),
        },
        webhooks: patch.webhooks.map(previewRow),
        timeoutMs: patch.timeoutMs,
        retries: patch.retries,
        logLevel: patch.logLevel,
        logDeliveries: patch.logDeliveries,
        testOnActivate: patch.testOnActivate,
      };
    }

    /** The generated block as YAML text. */
    function previewYaml(draft, base) {
      return toYaml(previewConfig(draft, base));
    }

    /** YAML generation that cannot break a render: a failure degrades to empty text. */
    function safeYaml(draft, base) {
      try {
        return previewYaml(draft, base);
      } catch (error) {
        warn('the config preview could not be generated', error);
        return '';
      }
    }

    /**
     * The paste-ready snippet: the profile row around the generated block.
     *
     * Shown to the user exactly as it is copied, because a row pasted without its
     * `- id:` line would be an anonymous entry the patch loader cannot match.
     */
    function pasteBlock(yamlText) {
      const body = text(yamlText).split('\n');
      return [`- id: ${ROW_ID}`, '  config:', ...body.map((line) => (line ? `    ${line}` : ''))].join('\n');
    }

    /** Hide credential-bearing YAML leaves without changing the surrounding layout. */
    function maskYamlSecrets(yamlText) {
      let headersIndent = null;
      return text(yamlText).split('\n').map((line) => {
        const indent = (line.match(/^\s*/) || [''])[0].length;
        const trimmed = line.trim();
        if (headersIndent !== null && trimmed && indent <= headersIndent) headersIndent = null;
        if (/^headers:\s*$/.test(trimmed)) {
          headersIndent = indent;
          return line;
        }
        const url = /^(\s*(?:-\s+)?url:\s*).*$/.exec(line);
        if (url) return `${url[1]}"<hidden>"`;
        if (headersIndent !== null && indent > headersIndent && /:\s*/.test(trimmed)) {
          const separator = line.indexOf(':');
          return `${line.slice(0, separator + 1)} "<hidden>"`;
        }
        return line;
      }).join('\n');
    }

    /* ------------------------------------------------------------------ *
     * namespace discovery
     * ------------------------------------------------------------------ */

    /** A namespace value that carries the notify-hook config shape. */
    function looksLikeNotifyHook(view) {
      return isObject(view) && isObject(view.value)
        && 'awaitingInputDelayMs' in view.value
        && 'webhooks' in view.value
        && 'desktop' in view.value;
    }

    /**
     * Find this plugin's namespace among everything the settings service reports.
     *
     * The namespace key is the profile entry's **patch id** — `notify-hook`, the `id:` of the
     * row in `cordis.patch.yml` — because the settings service builds it from
     * `entry.options.id`. It is NOT the loader's tree id (`include:notify-hook`), which is what
     * an earlier revision assumed; matching only on that made discovery fall through to the
     * config generator even though the namespace was published. The exact id, the loader id,
     * a `:notify-hook` suffix and finally the shape of the value are tried in turn.
     *
     * Every id match must also carry a plain-object `value`. `SettingsNamespaceView`
     * types `value` as `JsonValue`, so `null` is a legal answer meaning "this row has
     * no live configuration"; a view that matched only by id used to count as a
     * successful discovery, which rendered an editable form seeded from this client's
     * own `EDITABLE_DEFAULTS` whose Save (or test button) then wrote those defaults
     * over the user's row. No usable value means no match, so the caller renders the
     * config generator instead — a panel that explains the situation and hands over the
     * YAML rather than inventing a configuration to write.
     */
    function discoverView(namespaces) {
      const views = Array.isArray(namespaces) ? namespaces.filter(isObject) : [];
      const usable = (view) => isObject(view.value);
      const exact = views.find((view) => NS_IDS.includes(view.ns) && usable(view));
      if (exact) return exact;
      // Any id whose last segment is the row id: `include:notify-hook`, `profile:notify-hook`, …
      const suffixed = views.find(
        (view) => typeof view.ns === 'string' && view.ns.split(':').pop() === ROW_ID && usable(view),
      );
      if (suffixed) return suffixed;
      const marked = views.filter(looksLikeNotifyHook);
      return marked.length ? marked[0] : null;
    }

    /* ------------------------------------------------------------------ *
     * the two-step test notification
     * ------------------------------------------------------------------ */

    /** Resolve after a delay; `0` resolves immediately so tests need no timer. */
    function waitFor(ms) {
      const delay = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
      if (delay === 0) return Promise.resolve();
      return new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    }

    /**
     * Send one real test notification.
     *
     * The plugin's only write surface is its config, so this is a two-step dance:
     *
     * 1. write the form together with `testOnActivate: true` — persisting the row
     *    re-activates the host plugin, whose activation hook fires exactly one
     *    notification through the real desktop and webhook paths;
     * 2. wait past the host's awaiting-input delay, then write `testOnActivate: false`
     *    so a later config reload does not fire again.
     *
     * If step 2 fails the flag is deliberately left on and reported, so the user can
     * see it and switch it off rather than being silently re-notified forever.
     */
    function runTestNotification(options) {
      const settings = isObject(options) ? options : {};
      const update = settings.update;
      const ns = text(settings.ns);
      const patch = isObject(settings.patch) ? settings.patch : {};
      const delayMs = typeof settings.delayMs === 'number' ? settings.delayMs : TEST_DISARM_DELAY_MS.current;

      return Promise.resolve()
        .then(() => update(ns, { ...patch, testOnActivate: true }, settings.revision))
        .then((response) => unwrapRemoteResult(response, 'settings.update (test arm)'))
        .then((armedView) => {
          return waitFor(delayMs)
            .then(() => update(ns, { testOnActivate: false }, armedView.revision))
            .then((response) => unwrapRemoteResult(response, 'settings.update (test disarm)'))
            .catch((error) => {
              // Step 1 already landed, so the notification really was sent; only the
              // disarm failed. Tag the failure so the caller can leave the test switch
              // visibly on and adopt the armed revision instead of guessing.
              const failure = error instanceof Error ? error : new Error(messageOf(error));
              failure.testPhase = 'disarm';
              failure.armed = armedView;
              throw failure;
            });
        });
    }

    /* ------------------------------------------------------------------ *
     * styles
     * ------------------------------------------------------------------ */

    const T = {
      labelPrimary: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      borderL1: 'var(--dsw-alias-border-l1)',
      borderL2: 'var(--dsw-alias-border-l2)',
      bgBase: 'var(--dsw-alias-bg-base)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2)',
      bgOverlay: 'var(--dsw-alias-bg-overlay)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    };

    /** One font stack for the generated snippets; not a colour, so it is not a token. */
    const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        color: T.labelPrimary,
        fontSize: '13px',
        lineHeight: '20px',
        maxWidth: '760px',
        minWidth: 0,
      },
      card: {
        background: T.bgLayer1,
        border: `1px solid ${T.borderL1}`,
        borderRadius: '6px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minWidth: 0,
      },
      cardHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        paddingBottom: '8px',
        borderBottom: `1px solid ${T.borderL1}`,
      },
      cardTitle: { margin: 0, fontSize: '13px', fontWeight: 600, color: T.labelPrimary },
      headerTop: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
      title: { margin: 0, fontSize: '16px', fontWeight: 600, lineHeight: '24px', color: T.labelPrimary },
      subtitle: { margin: '2px 0 0', fontSize: '12px', color: T.labelSecondary },
      hint: { fontSize: '12px', color: T.labelSecondary, margin: 0 },
      field: { display: 'flex', alignItems: 'flex-start', gap: '10px', minWidth: 0 },
      fieldLabel: { flex: '0 0 210px', minWidth: 0, paddingTop: '4px' },
      fieldLabelText: { fontSize: '13px', color: T.labelPrimary },
      fieldControl: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
      input: {
        width: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        background: T.bgBase,
        color: T.labelPrimary,
        border: `1px solid ${T.borderL1}`,
        borderRadius: '6px',
        padding: '5px 8px',
        fontSize: '13px',
        fontFamily: 'inherit',
      },
      inputTight: { maxWidth: '160px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
      grow: { flex: '1 1 auto', minWidth: 0 },
      button: {
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        color: T.labelPrimary,
        background: T.bgLayer2,
        border: `1px solid ${T.borderL1}`,
        borderRadius: '6px',
        padding: '4px 10px',
        cursor: 'pointer',
      },
      buttonPrimary: {
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        fontWeight: 600,
        color: T.bgBase,
        background: T.brand,
        border: `1px solid ${T.brand}`,
        borderRadius: '6px',
        padding: '4px 14px',
        cursor: 'pointer',
      },
      buttonQuiet: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        color: T.labelSecondary,
        background: 'transparent',
        border: `1px solid ${T.borderL1}`,
        borderRadius: '6px',
        padding: '2px 8px',
        cursor: 'pointer',
      },
      segmented: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '2px',
        padding: '2px',
        background: T.bgLayer2,
        border: `1px solid ${T.borderL1}`,
        borderRadius: '6px',
      },
      segment: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        color: T.labelSecondary,
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: '4px',
        padding: '3px 10px',
        cursor: 'pointer',
      },
      segmentActive: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        fontWeight: 600,
        color: T.bgBase,
        background: T.brand,
        border: `1px solid ${T.brand}`,
        borderRadius: '4px',
        padding: '3px 10px',
        cursor: 'pointer',
      },
      switchTrack: {
        position: 'relative',
        flex: '0 0 auto',
        width: '34px',
        height: '20px',
        padding: 0,
        borderRadius: '10px',
        border: '1px solid transparent',
        cursor: 'pointer',
        transition: 'background 120ms ease',
      },
      switchKnob: {
        position: 'absolute',
        top: '2px',
        width: '14px',
        height: '14px',
        borderRadius: '50%',
        background: T.bgBase,
        transition: 'left 120ms ease',
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: '12px',
        lineHeight: '18px',
        color: T.labelSecondary,
        background: T.bgOverlay,
        border: `1px solid ${T.borderL2}`,
        borderRadius: '6px',
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      },
      rowBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        background: T.bgLayer2,
        border: `1px solid ${T.borderL1}`,
        borderRadius: '6px',
        padding: '8px',
        minWidth: 0,
      },
      footer: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      pre: {
        margin: 0,
        padding: '8px',
        background: T.bgBase,
        border: `1px solid ${T.borderL1}`,
        borderRadius: '6px',
        color: T.labelPrimary,
        fontFamily: MONO_FONT,
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'pre',
        overflow: 'auto',
        maxHeight: '340px',
      },
      textarea: {
        width: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        background: T.bgBase,
        color: T.labelPrimary,
        border: `1px solid ${T.borderL1}`,
        borderRadius: '6px',
        padding: '8px',
        fontFamily: MONO_FONT,
        fontSize: '12px',
        lineHeight: '18px',
        resize: 'vertical',
      },
    };

    /* ------------------------------------------------------------------ *
     * presentational helpers
     * ------------------------------------------------------------------ */

    /** A titled card with a separator under the title row. */
    function Card(props) {
      const children = [h('div', { key: 'head', style: S.cardHead }, h('h3', { style: S.cardTitle }, props.title))];
      if (props.hint) children.push(h('p', { key: 'hint', style: S.hint }, props.hint));
      children.push(h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 } }, props.children));
      return h('section', { style: S.card }, children);
    }

    /** Label + control row. `hint` renders under the label. */
    function Field(props) {
      const left = [h('div', { key: 'label', style: S.fieldLabelText }, props.label)];
      if (props.hint) left.push(h('div', { key: 'hint', style: S.hint }, props.hint));
      return h('div', { style: S.field }, [
        h('div', { key: 'left', style: S.fieldLabel }, left),
        h('div', { key: 'right', style: S.fieldControl }, props.children),
      ]);
    }

    /** Accessible on/off switch: `role="switch"`, `aria-checked`, Enter and Space. */
    function Switch(props) {
      const on = props.checked === true;
      const disabled = props.disabled === true;
      const toggle = () => {
        if (disabled) return;
        if (typeof props.onChange === 'function') props.onChange(on !== true);
      };
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': text(props.label) || undefined,
        disabled,
        onClick: toggle,
        onKeyDown: (event) => {
          const key = event && typeof event.key === 'string' ? event.key : '';
          if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            toggle();
          }
        },
        style: {
          ...S.switchTrack,
          background: on ? T.brand : T.idle,
          opacity: disabled ? 0.5 : 1,
        },
      }, h('span', { style: { ...S.switchKnob, left: on ? '17px' : '3px' } }));
    }

    /** Exclusive choice rendered as a segmented control. */
    function Segmented(props) {
      const options = Array.isArray(props.options) ? props.options : [];
      const value = props.value;
      return h('div', {
        role: 'radiogroup',
        'aria-label': text(props.label) || undefined,
        style: S.segmented,
      }, options.map((option) => {
        const active = option.value === value;
        return h('button', {
          key: String(option.value),
          type: 'button',
          role: 'radio',
          'aria-checked': active ? 'true' : 'false',
          disabled: props.disabled === true,
          onClick: () => {
            if (typeof props.onChange === 'function') props.onChange(option.value);
          },
          style: active ? S.segmentActive : S.segment,
        }, option.label);
      }));
    }

    /** Text / number input bound to a draft field. */
    function TextInput(props) {
      return h('input', {
        type: props.type === 'number' ? 'number' : (props.type === 'password' ? 'password' : 'text'),
        value: props.value,
        placeholder: props.placeholder === undefined ? undefined : props.placeholder,
        min: props.min,
        max: props.max,
        step: props.step,
        inputMode: props.type === 'number' ? 'numeric' : undefined,
        disabled: props.disabled === true,
        'aria-label': text(props.label) || undefined,
        onChange: (event) => {
          const next = event && event.target ? event.target.value : '';
          if (typeof props.onChange === 'function') props.onChange(typeof next === 'string' ? next : String(next));
        },
        style: { ...S.input, ...(props.tight ? S.inputTight : null) },
      });
    }

    /** Select bound to a draft field. */
    function Select(props) {
      const options = Array.isArray(props.options) ? props.options : [];
      return h('select', {
        value: props.value,
        disabled: props.disabled === true,
        'aria-label': text(props.label) || undefined,
        onChange: (event) => {
          const next = event && event.target ? event.target.value : '';
          if (typeof props.onChange === 'function') props.onChange(typeof next === 'string' ? next : String(next));
        },
        style: { ...S.input, maxWidth: '200px' },
      }, options.map((option) => h('option', { key: String(option.value), value: option.value }, option.label)));
    }

    /**
     * The options of the per-row type select.
     *
     * A stored type this build does not know gets an option of its own. Without it the
     * browser would show the first entry (`Auto-detect`) for a value no option matches,
     * and the next Save would make that display true — turning the host's refusal of an
     * unknown explicit type into live delivery.
     */
    function typeOptions(current, t) {
      const options = TARGET_TYPES.map((type) => ({ value: type, label: typeLabelFor(type, t) }));
      const unknown = text(current).trim();
      if (unknown && !TARGET_TYPES.includes(unknown)) {
        options.push({ value: unknown, label: typeLabelFor(unknown, t) });
      }
      return options;
    }

    /* ------------------------------------------------------------------ *
     * page
     * ------------------------------------------------------------------ */

    /**
     * The control surface: header, language, verbosity, events, desktop, targets and
     * advanced — every section, with the same components in the same order.
     *
     * Returned as sections rather than as a tree because both pages render it: the live
     * form appends a Save/test footer, and the config generator (which has nothing to
     * write) appends a YAML preview and paste instructions. Sharing one builder is what
     * keeps the two from drifting apart.
     */
    function renderControls(state, t, actions) {
      const draft = isObject(state.draft) ? state.draft : draftFromValue(null);
      const rows = Array.isArray(draft.webhooks) ? draft.webhooks : [];
      const activePreset = presetFor(draft.events, draft.minDurationMs);
      const problems = rows.map(rowProblem);
      const busy = state.saving === true || state.testing === true || state.refreshing === true;

      const targetPhrase = rows.length === 0
        ? t.targetsNone
        : (rows.length === 1 ? t.targetsOne : fmt(t.targetsMany, { n: rows.length }));
      const statusLine = draft.enabled === true
        ? `${draft.desktop && draft.desktop.enabled !== false ? t.statusDesktopOn : t.statusDesktopOff} · ${targetPhrase}`
        : t.statusDisabled;

      const sections = [];

      /* header */
      sections.push(h('section', { key: 'header', style: S.card }, [
        h('div', { key: 'top', style: S.headerTop }, [
          h('div', { key: 'titles', style: S.grow }, [
            h('h2', { key: 'title', style: S.title }, t.title),
            h('p', { key: 'status', style: S.subtitle }, statusLine),
          ]),
          h('div', { key: 'master', style: S.row }, [
            h('span', { key: 'label', style: { fontSize: '13px' } }, t.masterLabel),
            h(Switch, {
              key: 'switch',
              checked: draft.enabled === true,
              disabled: busy,
              label: t.masterLabel,
              onChange: (next) => actions.edit({ enabled: next }),
            }),
          ]),
        ]),
      ]));

      /* verbosity */
      const presetOptions = PRESET_KEYS.map((key) => ({
        value: key,
        label: t[`preset${key.charAt(0).toUpperCase()}${key.slice(1)}`],
      }));
      sections.push(h(Card, { key: 'verbosity', title: t.secVerbosity, hint: t.verbosityHint }, [
        h('div', { key: 'row', style: S.row }, [
          h(Segmented, {
            key: 'seg',
            label: t.secVerbosity,
            value: activePreset,
            disabled: busy,
            options: presetOptions,
            onChange: (next) => actions.applyPreset(next),
          }),
          activePreset === 'custom'
            ? h('span', { key: 'custom', style: { ...S.chip, color: T.warn } }, t.presetCustom)
            : null,
        ]),
        h('p', { key: 'presetHint', style: S.hint }, activePreset === 'custom'
          ? t.presetCustomHint
          : t[`preset${activePreset.charAt(0).toUpperCase()}${activePreset.slice(1)}Hint`]),
      ]));

      /* events */
      const eventLabels = {
        completed: [t.evCompleted, t.evCompletedHint],
        failed: [t.evFailed, ''],
        awaitingInput: [t.evAwaitingInput, t.evAwaitingInputHint],
        attention: [t.evAttention, ''],
        cancelled: [t.evCancelled, t.evCancelledHint],
      };
      const eventField = (key) => {
        const entry = eventLabels[key] || [key, ''];
        return h(Field, {
          key,
          label: entry[0],
          hint: entry[1] || undefined,
        }, h(Switch, {
          checked: draft.events[key] === true,
          disabled: busy,
          label: entry[0],
          onChange: (next) => actions.editEvent(key, next),
        }));
      };
      sections.push(h(Card, { key: 'events', title: t.secEvents, hint: t.eventsHint }, [
        'completed',
        'failed',
        'awaitingInput',
      ].map(eventField)));

      /* desktop */
      sections.push(h(Card, { key: 'desktop', title: t.secDesktop, hint: t.desktopHint }, [
        h(Field, { key: 'enabled', label: t.desktopEnabled }, h(Switch, {
          checked: draft.desktop.enabled !== false,
          disabled: busy,
          label: t.desktopEnabled,
          onChange: (next) => actions.editDesktop('enabled', next),
        })),
        h(Field, { key: 'sound', label: t.desktopSound }, h(Switch, {
          checked: draft.desktop.sound === true,
          disabled: busy,
          label: t.desktopSound,
          onChange: (next) => actions.editDesktop('sound', next),
        })),
      ]));

      /* webhook targets */
      const rowNodes = rows.map((row, index) => {
        const problem = problems[index];
        const effective = targetTypeOf(row);
        const off = row.enabled === false;
        const children = [];

        children.push(h('div', { key: 'head', style: S.row }, [
          h(Switch, {
            key: 'switch',
            checked: !off,
            disabled: busy,
            label: t.targetEnabled,
            onChange: (next) => actions.editRow(index, { enabled: next }),
          }),
          h('div', { key: 'name', style: S.grow }, h(TextInput, {
            value: row.name,
            placeholder: t.targetNamePlaceholder,
            label: t.targetName,
            disabled: busy,
            onChange: (next) => actions.editRow(index, { name: next }),
          })),
          h('button', {
            key: 'remove',
            type: 'button',
            disabled: busy,
            onClick: () => actions.removeRow(index),
            style: S.buttonQuiet,
          }, t.targetRemove),
        ]));

        children.push(h('div', { key: 'url', style: S.row }, [
          h(Select, {
            key: 'type',
            value: row.type,
            label: t.targetType,
            disabled: busy,
            options: typeOptions(row.type, t),
            onChange: (next) => actions.editRow(index, { type: next }),
          }),
          h('div', { key: 'input', style: S.grow }, h(TextInput, {
            type: actions.isWebhookUrlRevealed(index) ? 'text' : 'password',
            value: row.url,
            placeholder: t.targetUrlPlaceholder,
            label: t.targetUrl,
            disabled: busy,
            onChange: (next) => actions.editRow(index, { url: next }),
          })),
          h('button', {
            key: 'reveal',
            type: 'button',
            disabled: busy,
            onClick: () => actions.toggleWebhookUrl(index),
            style: S.buttonQuiet,
          }, actions.isWebhookUrlRevealed(index) ? t.targetHide : t.targetReveal),
          row.type === 'auto' && text(row.url).trim()
            ? h('span', { key: 'detected', style: S.chip }, fmt(t.detectedPrefix, { provider: actions.typeLabel(effective) }))
            : null,
        ]));

        if (effective === 'telegram') {
          children.push(h('div', { key: 'chat', style: S.row }, h('div', { style: S.grow }, h(TextInput, {
            value: row.chatId,
            placeholder: t.targetChatIdPlaceholder,
            label: t.targetChatId,
            disabled: busy,
            onChange: (next) => actions.editRow(index, { chatId: next }),
          }))));
        }

        if (problem === 'missing' || problem === 'scheme') {
          children.push(h('p', { key: 'problem', style: { ...S.hint, color: T.error } }, problem === 'missing' ? t.urlMissing : t.urlInvalid));
        } else if (off) {
          children.push(h('p', { key: 'off', style: S.hint }, t.rowDisabledHint));
        }

        return h('div', {
          key: `row-${index}`,
          style: problem ? { ...S.rowBox, border: `1px solid ${T.error}`, opacity: off ? 0.7 : 1 } : { ...S.rowBox, opacity: off ? 0.7 : 1 },
        }, children);
      });

      sections.push(h(Card, { key: 'targets', title: t.secTargets, hint: t.targetsHint }, [
        rows.length === 0 ? h('p', { key: 'empty', style: S.hint }, t.targetsEmpty) : null,
        ...rowNodes,
        h('div', { key: 'add', style: S.row }, [
          h('button', {
            key: 'addOne',
            type: 'button',
            disabled: busy,
            onClick: () => actions.addRow('auto'),
            style: S.button,
          }, t.targetAdd),
          h('span', { key: 'quickLabel', style: { ...S.hint, marginLeft: '4px' } }, t.quickAdd),
          ...QUICK_ADD.map((provider) => h('button', {
            key: `quick-${provider}`,
            type: 'button',
            disabled: busy,
            onClick: () => actions.addRow(provider),
            style: S.buttonQuiet,
          }, actions.typeLabel(provider))),
        ]),
      ]));

      /* advanced */
      sections.push(h(Card, { key: 'advanced', title: t.secAdvanced }, [
        ...['attention', 'cancelled'].map(eventField),
        h(Field, {
          key: 'minDuration',
          label: t.fieldMinDuration,
        }, h(TextInput, {
          type: 'number',
          value: draft.minDurationMs,
          min: NUMERIC_LIMITS.minDurationMs[0],
          max: NUMERIC_LIMITS.minDurationMs[1],
          label: t.fieldMinDuration,
          disabled: busy,
          tight: true,
          onChange: (next) => actions.edit({ minDurationMs: next }),
        }), h('p', { style: S.hint }, t.unitMs)),
        h(Field, { key: 'awaiting', label: t.fieldAwaitingDelay }, h(TextInput, {
          type: 'number',
          value: draft.awaitingInputDelayMs,
          min: NUMERIC_LIMITS.awaitingInputDelayMs[0],
          max: NUMERIC_LIMITS.awaitingInputDelayMs[1],
          label: t.fieldAwaitingDelay,
          disabled: busy,
          tight: true,
          onChange: (next) => actions.edit({ awaitingInputDelayMs: next }),
        }), h('p', { style: S.hint }, t.unitMs)),
        h(Field, { key: 'dedupe', label: t.fieldDedupeWindow }, h(TextInput, {
          type: 'number',
          value: draft.dedupeWindowMs,
          min: NUMERIC_LIMITS.dedupeWindowMs[0],
          max: NUMERIC_LIMITS.dedupeWindowMs[1],
          label: t.fieldDedupeWindow,
          disabled: busy,
          tight: true,
          onChange: (next) => actions.edit({ dedupeWindowMs: next }),
        }), h('p', { style: S.hint }, t.unitMs)),
        h(Field, { key: 'timeout', label: t.fieldTimeout }, h(TextInput, {
          type: 'number',
          value: draft.timeoutMs,
          min: NUMERIC_LIMITS.timeoutMs[0],
          max: NUMERIC_LIMITS.timeoutMs[1],
          label: t.fieldTimeout,
          disabled: busy,
          tight: true,
          onChange: (next) => actions.edit({ timeoutMs: next }),
        }), h('p', { style: S.hint }, t.unitMs)),
        h(Field, { key: 'retries', label: t.fieldRetries }, h(TextInput, {
          type: 'number',
          value: draft.retries,
          min: NUMERIC_LIMITS.retries[0],
          max: NUMERIC_LIMITS.retries[1],
          label: t.fieldRetries,
          disabled: busy,
          tight: true,
          onChange: (next) => actions.edit({ retries: next }),
        })),
        h(Field, { key: 'logLevel', label: t.fieldLogLevel }, h(Select, {
          value: draft.logLevel,
          label: t.fieldLogLevel,
          disabled: busy,
          options: [
            { value: 'silent', label: t.levelSilent },
            { value: 'error', label: t.levelError },
            { value: 'warn', label: t.levelWarn },
            { value: 'info', label: t.levelInfo },
          ],
          onChange: (next) => actions.edit({ logLevel: next }),
        })),
        h(Field, {
          key: 'subagents',
          label: t.fieldIncludeSubagents,
          hint: t.fieldIncludeSubagentsHint,
        }, h(Switch, {
          checked: draft.includeSubagents === true,
          disabled: busy,
          label: t.fieldIncludeSubagents,
          onChange: (next) => actions.edit({ includeSubagents: next }),
        })),
        h(Field, {
          key: 'logDeliveries',
          label: t.fieldLogDeliveries,
          hint: t.fieldLogDeliveriesHint,
        }, h(Switch, {
          checked: draft.logDeliveries !== false,
          disabled: busy,
          label: t.fieldLogDeliveries,
          onChange: (next) => actions.edit({ logDeliveries: next }),
        })),
        h(Field, {
          key: 'testOnActivate',
          label: t.fieldTestOnActivate,
          hint: t.fieldTestOnActivateHint,
        }, h(Switch, {
          checked: draft.testOnActivate === true,
          disabled: busy,
          label: t.fieldTestOnActivate,
          onChange: (next) => actions.edit({ testOnActivate: next }),
        })),
      ]));

      return { sections, draft, rows, problems, busy };
    }

    /**
     * The live form: the shared control surface plus the footer that writes it.
     *
     * The footer is the only part that needs a live namespace, so it is the only part
     * the generator (see {@link renderGenerator}) leaves out.
     */
    function renderPage(state, t, actions) {
      const { sections, draft, problems, busy } = renderControls(state, t, actions);
      const blocked = problems.some((problem) => problem !== null);
      // Derived, never stored: "dirty" means "saving would change the config", which is
      // exactly what `patchOf` produces, so an emptied number field that falls back to
      // its default is correctly reported as unchanged.
      const dirty = isDirty(draft, state.adopted);
      // Writing needs a live value to merge into. Without one the patch would be this
      // client's own defaults, so Save and the test button stay disabled: that is the
      // second half of the "a namespace with no usable value is not a discovery" rule
      // in `discoverView` (a no-value view returned by `update` must not arm a write
      // either).
      const writable = state.phase === 'ready' && Boolean(state.ns) && isObject(state.adopted);

      const notice = isObject(state.notice) ? state.notice : null;
      const noticeColor = notice && notice.kind === 'error'
        ? T.error
        : notice && (notice.kind === 'ok' || notice.kind === 'test')
          ? T.success
          : T.labelSecondary;
      const statusText = actions.statusText(t, state, { blocked, dirty });
      const canSave = writable && blocked !== true && busy !== true && dirty === true;
      const canTest = writable && blocked !== true && busy !== true;
      const canReloadLatest = writable && busy !== true && notice && notice.kind === 'error' && notice.scope === 'save';

      const footer = h('section', { key: 'footer', style: S.card }, [
        h('div', { key: 'actions', style: S.footer }, [
          h('button', {
            key: 'save',
            type: 'button',
            disabled: !canSave,
            onClick: actions.save,
            style: { ...S.buttonPrimary, opacity: canSave ? 1 : 0.5, cursor: canSave ? 'pointer' : 'default' },
          }, state.saving === true ? t.statusSaving : t.footerSave),
          canReloadLatest ? h('button', {
            key: 'reload-latest',
            type: 'button',
            onClick: actions.reloadLatest,
            style: S.button,
          }, t.footerReloadLatest) : null,
          h('button', {
            key: 'test',
            type: 'button',
            disabled: !canTest,
            onClick: actions.sendTest,
            style: {
              ...S.button,
              opacity: canTest ? 1 : 0.5,
              cursor: canTest ? 'pointer' : 'default',
            },
          }, state.testing === true ? t.statusTesting : t.footerSendTest),
          h('span', { key: 'status', style: { fontSize: '12px', color: noticeColor } }, statusText),
        ]),
        h('p', { key: 'testHint', style: S.hint }, t.footerSendTestHint),
        blocked ? h('p', { key: 'blocked', style: { ...S.hint, color: T.error } }, t.fixRowsFirst) : null,
      ]);

      return h('div', { style: S.root }, [...sections, footer]);
    }

    /** Select the whole textarea on click or focus, so the manual copy is one keypress away. */
    function selectAllOf(event) {
      try {
        const target = event && event.target ? event.target : null;
        if (target && typeof target.select === 'function') target.select();
      } catch {
        /* selecting is a convenience; a failure must not break the panel */
      }
    }

    /**
     * The config generator: what this panel renders when the settings service offers no
     * live namespace.
     *
     * This is an explicit recovery path. A correctly installed package exposes a live
     * settings namespace; when discovery is unavailable or malformed, this page keeps
     * the controls useful without pretending it has a safe write surface. It emits a
     * complete YAML block and the diagnostic needed to repair the installation.
     *
     * There is deliberately no second, reduced form here: the sections come from
     * {@link renderControls}, the same builder the live page uses.
     */
    function renderGenerator(state, t, actions) {
      const controls = renderControls(state, t, actions);
      const fullPreviewText = text(actions.previewText());
      const fullPasteText = text(actions.pasteText());
      const secretsRevealed = state.revealGeneratedSecrets === true;
      const previewText = secretsRevealed ? fullPreviewText : maskYamlSecrets(fullPreviewText);
      const pasteText = secretsRevealed ? fullPasteText : maskYamlSecrets(fullPasteText);
      const copied = text(state.copied);
      const manualCopy = text(state.manualCopy);
      const errorText = text(state.loadError);

      /**
       * One generated snippet: the block, its Copy button, and — when the clipboard is
       * unavailable or refuses the write — the selectable textarea to copy by hand.
       */
      const block = (key, label, copyTarget, buttonLabel, value) => h('div', {
        key,
        style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
      }, [
        h('pre', { key: 'text', style: S.pre, 'aria-label': label }, value),
        h('div', { key: 'actions', style: S.row }, h('button', {
          key: 'copy',
          type: 'button',
          onClick: () => actions.copy(copyTarget),
          style: copied === copyTarget ? S.buttonPrimary : S.button,
        }, copied === copyTarget ? t.genCopied : buttonLabel)),
        manualCopy === copyTarget
          ? h('p', { key: 'manualHint', style: S.hint }, t.genManualHint)
          : null,
        manualCopy === copyTarget
          ? h('textarea', {
            key: 'manual',
            readOnly: true,
            rows: 14,
            value,
            'aria-label': t.genManualHint,
            onFocus: selectAllOf,
            onClick: selectAllOf,
            style: S.textarea,
          })
          : null,
      ]);

      const note = h('section', { key: 'note', style: S.card }, [
        h('h2', { key: 'title', style: { ...S.title, fontSize: '15px' } }, t.genTitle),
        h('p', { key: 'note', style: S.hint }, t.genNote),
        errorText
          ? h('p', { key: 'error', style: { ...S.hint, color: T.warn } }, fmt(t.genErrorPrefix, { message: errorText }))
          : null,
        h('details', {
          key: 'diag',
          style: {
            margin: '8px 0 0',
            padding: '8px 10px',
            background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '6px',
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, [
          h('summary', { key: 'summary', style: { cursor: 'pointer', fontSize: '12px' } }, t.technicalDetails),
          h('p', {
            key: 'body',
            style: {
              margin: '8px 0 0',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '11px',
              lineHeight: 1.5,
              color: 'var(--dsw-alias-label-secondary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            },
          }, `version: ${String(VERSION)}\n${text(state.diagnostic) || '(no diagnostic captured)'}`),
        ]),
        h('div', { key: 'retry', style: S.row }, h('button', {
          key: 'again',
          type: 'button',
          onClick: actions.retry,
          style: S.button,
        }, t.genRetry)),
      ]);

      const previewCard = h(Card, { key: 'preview', title: t.genPreviewTitle, hint: t.genPreviewHint }, [
        h('div', { key: 'secret-controls', style: S.row }, [
          h('button', {
            key: 'toggle-secrets',
            type: 'button',
            onClick: actions.toggleGeneratedSecrets,
            style: secretsRevealed ? S.buttonPrimary : S.button,
          }, secretsRevealed ? t.genHideSecrets : t.genRevealSecrets),
          h('span', { key: 'secret-hint', style: S.hint }, t.genSecretsHint),
        ]),
        block('preview-block', t.genPreviewTitle, 'preview', t.genCopy, previewText),
      ]);

      const pasteCard = h(Card, { key: 'paste', title: t.genPasteTitle }, [
        h('p', { key: 'where', style: S.hint }, t.genPasteWhere),
        block('paste-block', t.genPasteTitle, 'row', t.genPasteCopy, pasteText),
        h('div', { key: 'notes', style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 } }, [
          h('p', { key: 'layer', style: S.hint }, t.genPasteLayer),
          h('p', { key: 'replaces', style: S.hint }, t.genPasteReplaces),
          h('p', { key: 'reload', style: S.hint }, t.genPasteReload),
          h('p', { key: 'defaults', style: S.hint }, t.genPasteDefaults),
        ]),
      ]);

      return h('div', { style: S.root }, [note, ...controls.sections, previewCard, pasteCard]);
    }

    /* ------------------------------------------------------------------ *
     * the component
     * ------------------------------------------------------------------ */

    /** Initial component state; every later change goes through a functional update. */
    function initialState() {
      return {
        phase: 'loading',
        ns: '',
        revision: undefined,
        adopted: null,
        draft: null,
        loadError: '',
        saving: false,
        testing: false,
        refreshing: false,
        notice: null,
        /** Which snippet the clipboard last took: `'preview'`, `'row'` or `''`. */
        copied: '',
        /** Which snippet has to be selected by hand because copying is unavailable. */
        manualCopy: '',
        /** Revealed webhook URL inputs, keyed by the current row index. */
        revealedWebhookUrls: {},
        /** Whether recovery snippets display full URL/header values. */
        revealGeneratedSecrets: false,
        reloadToken: 0,
      };
    }

    /** Adopt a `NamespaceView` returned by `describe()` or `update()`. */
    function adopt(view, previous) {
      const source = isObject(view) ? view : {};
      const value = isObject(source.value) ? source.value : null;
      const revision = typeof source.revision === 'number' ? source.revision : previous;
      /** @type {Record<string, unknown>} */
      const next = {
        adopted: value,
        revision,
        // Indexes are presentation state, not row identity. Any authoritative
        // replacement masks every row again so a reorder cannot reveal another URL.
        revealedWebhookUrls: {},
        revealGeneratedSecrets: false,
      };
      if (value) next.draft = draftFromValue(value);
      return next;
    }

    /**
     * Build the props-less settings page bound to one plugin context.
     *
     * The slot owner passes no props, so the context is closed over here. Every hook
     * is called unconditionally at the top; only the final render is wrapped, which is
     * why a failure degrades to the config generator instead of blanking the slot.
     */
    function createSettingsPage(ctx) {
      const remote = ctx && ctx.remote && ctx.remote.settings ? ctx.remote.settings : null;

      return function SettingsPage() {
        const [state, setState] = React.useState(initialState);
        const mounted = React.useRef(true);

        React.useEffect(() => {
          mounted.current = true;
          return () => {
            mounted.current = false;
          };
        }, []);

        React.useEffect(() => {
          let cancelled = false;
          const alive = () => cancelled !== true && mounted.current === true;

          (async () => {
            try {
              if (!remote || typeof remote.describe !== 'function') {
                throw new Error('remote.settings.describe is unavailable');
              }
              const described = unwrapRemoteResult(await remote.describe(), 'settings.describe');
              if (!alive()) return;
              const views = isObject(described) && Array.isArray(described.namespaces) ? described.namespaces : [];
              // A one-line account of what this panel actually received over the wire. It is
              // deliberately visible in the generator: when discovery fails while the host
              // insists the namespace exists, this is the only ground truth available without
              // a browser console, and it says whether the id, the value or the whole call is
              // the problem.
              const diagnostic = [
                `describe: ${isObject(described) ? 'ok' : `not an object (${typeof described})`}`,
                `writable: ${String(isObject(described) ? described.writable : '?')}`,
                `namespaces: ${views.length}`,
                `ids: ${views.map((view) => (isObject(view) ? String(view.ns) : '?')).join(', ') || '(none)'}`,
                `ids matched: ${views.filter((view) => isObject(view) && NS_IDS.includes(view.ns)).length}`,
                `marker matched: ${views.filter(looksLikeNotifyHook).length}`,
                `id types: ${views.map((view) => (isObject(view) ? typeof view.ns : typeof view)).join(',') || '(none)'}`,
                `value types: ${views.map((view) => (isObject(view) ? (view.value === null ? 'null' : typeof view.value) : '?')).join(',') || '(none)'}`,
              ].join(' | ');
              const found = discoverView(views);
              if (!found) {
                // The expected outcome for a dependency-free plugin: no namespace is
                // projected, so there is nothing to read and nothing to write. The
                // generator takes over with a draft seeded from the defaults, which the
                // user then edits into the YAML block they paste.
                setState((previous) => ({
                  ...previous,
                  phase: 'generate',
                  loadError: '',
                  diagnostic,
                  adopted: null,
                  draft: draftFromValue(null),
                }));
                return;
              }
              setState((previous) => ({
                ...previous,
                phase: 'ready',
                ns: text(found.ns),
                loadError: '',
                diagnostic,
                ...adopt(found, previous.revision),
              }));
            } catch (error) {
              if (!alive()) return;
              const safeMessage = sanitizeUiMessage(error);
              warn('namespace discovery failed', safeMessage);
              setState((previous) => ({
                ...previous,
                phase: 'generate',
                loadError: safeMessage,
                diagnostic: `describe threw: ${safeMessage}`,
                adopted: null,
                draft: draftFromValue(null),
              }));
            }
          })();

          return () => {
            cancelled = true;
          };
        }, [state.reloadToken]);

        // DSH owns the interface language. The legacy config.locale stays in the draft
        // only as a Host notification fallback; it no longer creates a second UI switch.
        const t = localeStrings(ctx.locale);
        const actions = createActions({ t, state, setState, remote, mounted });

        try {
          return state.phase === 'generate'
            ? renderGenerator(state, t, actions)
            : renderPage(state, t, actions);
        } catch (error) {
          warn('render failed', error);
          try {
            return renderGenerator({ ...state, loadError: state.loadError || messageOf(error) }, t, actions);
          } catch (nested) {
            warn('generator render failed', nested);
            return h('div', { style: { padding: '12px', fontSize: '13px', color: T.labelPrimary } }, STRINGS.en.genTitle);
          }
        }
      };
    }

    /**
     * Handlers and small derived helpers.
     *
     * Rebuilt every render on purpose: every mutation is a functional update, so a
     * stale closure can never write an outdated draft, and nothing downstream
     * compares handler identity.
     */
    function createActions(deps) {
      const { t, state, setState, remote, mounted } = deps;
      const alive = () => mounted.current === true;

      /**
       * Apply a new draft and retire everything that described the old one.
       *
       * `notice` is the live form's save status, and `copied`/`manualCopy` are the
       * generator's: a confirmation that survives an edit would claim the clipboard
       * holds the snippet on screen when it holds the previous one.
       */
      const withDraft = (previous, draft) => ({
        ...previous,
        draft,
        notice: null,
        copied: '',
        manualCopy: '',
        revealGeneratedSecrets: false,
      });

      const draftOf = (previous) => (isObject(previous.draft) ? previous.draft : draftFromValue(null));

      /** Merge fields into the draft. */
      const edit = (partial) => setState((previous) => withDraft(previous, { ...draftOf(previous), ...partial }));

      const editEvent = (key, value) => setState((previous) => {
        const draft = draftOf(previous);
        return withDraft(previous, { ...draft, events: { ...draft.events, [key]: value } });
      });

      const editDesktop = (key, value) => setState((previous) => {
        const draft = draftOf(previous);
        return withDraft(previous, { ...draft, desktop: { ...draft.desktop, [key]: value } });
      });

      const editRow = (index, partial) => setState((previous) => {
        const draft = draftOf(previous);
        const rows = Array.isArray(draft.webhooks) ? draft.webhooks : [];
        return withDraft(previous, { ...draft, webhooks: rows.map((row, i) => (i === index ? { ...row, ...partial } : row)) });
      });

      const addRow = (provider) => setState((previous) => {
        const draft = draftOf(previous);
        const rows = Array.isArray(draft.webhooks) ? draft.webhooks : [];
        const type = TARGET_TYPES.includes(provider) ? provider : 'auto';
        return {
          ...withDraft(previous, { ...draft, webhooks: [...rows, newRow(type, type === 'auto' ? '' : typeLabel(type))] }),
          revealedWebhookUrls: {},
        };
      });

      const removeRow = (index) => setState((previous) => {
        const draft = draftOf(previous);
        const rows = Array.isArray(draft.webhooks) ? draft.webhooks : [];
        return {
          ...withDraft(previous, { ...draft, webhooks: rows.filter((row, i) => i !== index) }),
          revealedWebhookUrls: {},
        };
      });

      const isWebhookUrlRevealed = (index) => isObject(state.revealedWebhookUrls)
        && state.revealedWebhookUrls[index] === true;

      const toggleWebhookUrl = (index) => setState((previous) => {
        const revealed = isObject(previous.revealedWebhookUrls) ? previous.revealedWebhookUrls : {};
        return {
          ...previous,
          revealedWebhookUrls: { ...revealed, [index]: revealed[index] !== true },
        };
      });

      const applyPreset = (key) => {
        const preset = PRESETS[key];
        if (!preset) return;
        edit({ events: { ...preset.events }, minDurationMs: String(preset.minDurationMs) });
      };

      const save = async () => {
        if (!alive() || !remote || !state.ns || state.saving === true || state.testing === true || state.refreshing === true) return;
        const rows = isObject(state.draft) && Array.isArray(state.draft.webhooks) ? state.draft.webhooks : [];
        if (rows.some((row) => rowProblem(row) !== null)) return;

        setState((previous) => ({ ...previous, saving: true, notice: null }));
        try {
          const view = unwrapRemoteResult(
            await remote.update(state.ns, patchOf(state.draft, state.adopted), state.revision),
            'settings.update',
          );
          if (!alive()) return;
          setState((previous) => ({ ...previous, saving: false, notice: { kind: 'ok' }, ...adopt(view, previous.revision) }));
        } catch (error) {
          const safeMessage = sanitizeUiMessage(error);
          warn('save failed', safeMessage);
          if (!alive()) return;
          setState((previous) => ({
            ...previous,
            saving: false,
            notice: { kind: 'error', scope: 'save', message: safeMessage },
          }));
        }
      };

      /** Reread the authoritative revision and replay only the user's changed leaves. */
      const reloadLatest = async () => {
        if (!alive() || !remote || typeof remote.describe !== 'function' || !state.ns
          || state.saving === true || state.testing === true || state.refreshing === true) return;
        setState((previous) => ({ ...previous, refreshing: true, notice: null }));
        try {
          const described = unwrapRemoteResult(await remote.describe(), 'settings.describe');
          const views = isObject(described) && Array.isArray(described.namespaces) ? described.namespaces : [];
          const found = views.find((view) => isObject(view) && view.ns === state.ns && isObject(view.value))
            || discoverView(views);
          if (!found || !isObject(found.value)) throw new Error('the latest settings namespace has no usable value');
          const base = draftFromValue(state.adopted);
          const latest = draftFromValue(found.value);
          const rebased = rebaseDraft(draftOf(state), base, latest);
          if (!alive()) return;
          setState((previous) => ({
            ...previous,
            ...adopt(found, previous.revision),
            draft: rebased,
            ns: text(found.ns) || previous.ns,
            phase: 'ready',
            refreshing: false,
            notice: { kind: 'rebased' },
          }));
        } catch (error) {
          const safeMessage = sanitizeUiMessage(error);
          warn('reload latest failed', safeMessage);
          if (!alive()) return;
          setState((previous) => ({
            ...previous,
            refreshing: false,
            notice: { kind: 'error', scope: 'save', message: safeMessage },
          }));
        }
      };

      const sendTest = async () => {
        if (!alive() || !remote || !state.ns || state.saving === true || state.testing === true) return;
        const rows = isObject(state.draft) && Array.isArray(state.draft.webhooks) ? state.draft.webhooks : [];
        if (rows.some((row) => rowProblem(row) !== null)) return;

        setState((previous) => ({ ...previous, testing: true, notice: null }));
        try {
          const patch = patchOf(state.draft, state.adopted);
          const armed = await runTestNotification({
            update: remote.update.bind(remote),
            ns: state.ns,
            patch,
            revision: state.revision,
            delayMs: TEST_DISARM_DELAY_MS.current,
          });
          if (!alive()) return;
          setState((previous) => ({ ...previous, testing: false, notice: { kind: 'test' }, ...adopt(armed, previous.revision) }));
        } catch (error) {
          const safeMessage = sanitizeUiMessage(error);
          warn('test notification failed', safeMessage);
          if (!alive()) return;
          // A failed disarm leaves `testOnActivate: true` in the host on purpose, so
          // adopt the armed view: the switch stays visibly ON and the user can turn it
          // off by hand instead of being silently re-notified on every reload.
          const disarmFailed = Boolean(error) && error.testPhase === 'disarm';
          setState((previous) => ({
            ...previous,
            testing: false,
            notice: {
              kind: 'error',
              scope: disarmFailed ? 'testDisarm' : 'test',
              message: safeMessage,
            },
            ...(disarmFailed ? adopt(error.armed, previous.revision) : null),
          }));
        }
      };

      const retry = () => setState((previous) => ({
        ...previous,
        phase: 'loading',
        loadError: '',
        copied: '',
        manualCopy: '',
        revealGeneratedSecrets: false,
        reloadToken: previous.reloadToken + 1,
      }));

      const toggleGeneratedSecrets = () => setState((previous) => ({
        ...previous,
        revealGeneratedSecrets: previous.revealGeneratedSecrets !== true,
      }));

      /** The generated config block for the draft on screen; never throws. */
      const previewText = () => safeYaml(state.draft, state.adopted);

      /** The paste-ready row snippet for the draft on screen; never throws. */
      const pasteText = () => pasteBlock(safeYaml(state.draft, state.adopted));

      /**
       * Put one snippet on the clipboard.
       *
       * `navigator.clipboard` is only present in a secure context and the write can be
       * refused (a permission prompt, a document that is not focused), so every path
       * ends in either a confirmation or the selectable textarea — never in a throw and
       * never in a silently lost click.
       */
      const copy = (target) => {
        const which = target === 'row' ? 'row' : 'preview';
        const settle = (next) => {
          if (!alive()) return;
          setState((previous) => ({ ...previous, ...next }));
        };
        const manual = () => settle({ copied: '', manualCopy: which });

        let value = '';
        try {
          value = which === 'row' ? pasteText() : previewText();
        } catch (error) {
          warn('the snippet to copy could not be generated', error);
          return;
        }

        const nav = navigatorObject();
        const clipboard = isObject(nav) ? nav.clipboard : null;
        const write = clipboard && typeof clipboard.writeText === 'function' ? clipboard.writeText.bind(clipboard) : null;
        if (!write) {
          manual();
          return;
        }
        try {
          Promise.resolve(write(value)).then(
            () => settle({ copied: which, manualCopy: '' }),
            (error) => {
              warn('the clipboard rejected the write', sanitizeUiMessage(error));
              manual();
            },
          );
        } catch (error) {
          warn('the clipboard threw', sanitizeUiMessage(error));
          manual();
        }
      };

      /** Localized provider label used by selects, quick-add and the detected chip. */
      const typeLabel = (type) => typeLabelFor(type, t);

      /** Footer status line: one place that decides what the user is told. */
      const statusText = (strings, current, info) => {
        const notice = isObject(current.notice) ? current.notice : null;
        if (current.phase === 'loading') return strings.statusLoading;
        if (current.refreshing === true) return strings.statusRefreshing;
        if (current.saving === true) return strings.statusSaving;
        if (current.testing === true) return strings.statusTesting;
        if (notice && notice.kind === 'error') {
          if (notice.scope === 'testDisarm') return strings.statusTestDisarmFailed;
          if (notice.scope === 'test') return fmt(strings.statusTestFailed, { message: text(notice.message) });
          return fmt(strings.statusSaveFailed, { message: text(notice.message) });
        }
        if (notice && notice.kind === 'test') return strings.statusTestSent;
        if (notice && notice.kind === 'ok') return strings.statusSaved;
        if (notice && notice.kind === 'rebased') return strings.statusRebased;
        if (info && info.blocked) return strings.fixRowsFirst;
        if (info && info.dirty) return strings.statusUnsaved;
        return strings.statusSaved;
      };

      return {
        edit,
        editEvent,
        editDesktop,
        editRow,
        addRow,
        removeRow,
        isWebhookUrlRevealed,
        toggleWebhookUrl,
        applyPreset,
        save,
        reloadLatest,
        sendTest,
        retry,
        toggleGeneratedSecrets,
        copy,
        previewText,
        pasteText,
        typeLabel,
        statusText,
      };
    }

    /** Provider label for a target type, in the language currently rendered. */
    function typeLabelFor(type, t) {
      const strings = isObject(t) ? t : STRINGS.en;
      const name = text(type).trim();
      if (name === 'auto') return strings.typeAuto;
      const key = `type${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      if (typeof strings[key] === 'string') return strings[key];
      // A type this build does not know is named as unknown (with the raw value, so the
      // user can see what to fix) rather than being presented as one of the providers
      // it is not. The raw name is the last resort for a caller with no strings table.
      if (name && !TARGET_TYPES.includes(name)) return fmt(strings.typeUnknown, { type: name }) || name;
      return strings.typeGeneric;
    }

    /* ------------------------------------------------------------------ *
     * registration
     * ------------------------------------------------------------------ */

    /** Required Cordis services. */
    const inject = ['slots', 'remote', 'remote.settings', 'locale'];

    /**
     * Register the Notifications tab.
     *
     * The page is a props-less component closed over `ctx`, because the slot owner
     * renders entries with no extra props.
     */
    function apply(ctx) {
      try {
        ctx.effect(
          () => ctx.locale.register(LOCALE_NS, { zh: STRINGS.zh, en: STRINGS.en }),
          'dsh-notification-hook: locale dictionaries',
        );
        const translate = ctx.locale.bind(LOCALE_NS);
        const SettingsPage = createSettingsPage(ctx);
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: ROW_ID,
          order: TAB_ORDER,
          label: () => translate('tabLabel'),
          locale: LOCALE_NS,
        }, SettingsPage));
      } catch (error) {
        // `ctx.slots.inject` re-runs this callback whenever the slot owner re-declares
        // the slot, so an owner that has not declared it yet is not an error path; what
        // lands here is a genuine registration conflict (e.g. another entry already
        // owns this id at this order). The tab then never appears and nothing in the UI
        // says why, so this is reported at error level with the slot and the bundle
        // named, which is what makes it findable in the browser console.
        logError(`registration failed for slot "${SLOT}" in bundle dsh-notification-hook (entry "${ROW_ID}")`, error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    /**
     * Test surface. The browser never touches this; `test/client.test.mjs` drives the
     * pure helpers (presets, discovery projection, provider sniffing, the YAML preview,
     * the test dance) without a DOM.
     */
    exports.__test = {
      PRESETS,
      presetFor,
      detectTargetType,
      targetTypeOf,
      STRINGS,
      EDITABLE_DEFAULTS,
      NUMERIC_LIMITS,
      TEST_DISARM_DELAY_MS,
      draftFromValue,
      patchOf,
      rowProblem,
      rowFromValue,
      newRow,
      isDirty,
      discoverView,
      unwrapRemoteResult,
      sanitizeUiMessage,
      rebaseDraft,
      maskYamlSecrets,
      runTestNotification,
      createSettingsPage,
      typeLabelFor,
      toYaml,
      yamlScalar,
      needsQuotes,
      previewConfig,
      previewYaml,
      safeYaml,
      pasteBlock,
      SLOT,
      ROW_ID,
      NS_IDS,
    };

    return module.exports;
  },
});
