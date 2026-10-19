# DSH 任务提醒 — 桌面通知与多平台推送

[English](README.md) | 简体中文

[![CI](https://github.com/cyrillee0413-bit/dsh-notification-hook/actions/workflows/ci.yml/badge.svg)](https://github.com/cyrillee0413-bit/dsh-notification-hook/actions/workflows/ci.yml)

把任务交给 DeepSeek Harness（DSH）后，可以切去做别的事。任务**完成、失败或需要你输入**时再收到提醒，包括权限确认和 Agent 提问。

- **桌面与聊天软件同时提醒**：支持桌面通知、飞书、企业微信、Telegram、Discord、Slack 和通用 JSON Webhook。
- **减少打扰**：过滤很快完成的任务、延迟权限确认提醒，每个目标可以单独开关。
- **直接在 DSH 设置**：提供可编辑的设置页面，语言跟随 DSH，无需额外构建。

## 快速开始

已安装 DSH 的情况下，运行：

```powershell
dsh plugin --profile desktop add dsh-notification-hook@0.3.0
```

`desktop` 是桌面应用使用的 profile。如果你使用其他 profile，请将 `desktop` 替换为对应名称。

重启 DSH，打开 **设置 → 内置插件 → 任务提醒**，启用需要的目标，然后点击 **发送测试通知**。Telegram 等平台的填写方法见 [推送平台配置说明书](docs/WEBHOOK-GUIDE.zh.md)。

正常从 npm 安装会自动安装所需的官方运行时组件，**不需要克隆源码，也不需要手动运行 `npm ci`**。

`0.3.0` 已在 DSH `0.2.0-rc.2` 上验证，声明的兼容范围为 `>=0.2.0-rc.2 <0.3.0`。

## 哪些状态会提醒

设置页把最常用的三个结果放在主区域：

- 已完成：`turn/end` 的 `reason.kind === 'completed'`；
- 失败：`turn/end` 的 `reason.kind === 'error'`；
- 等待输入：仍未处理的权限确认、Agent 提问或 blocked 回合。

“需要关注”（`max-tokens`）和“已取消”（`aborted` / `interrupted`）移到“高级”区域，但五种状态仍可分别开关。

完成或取消的短回合可以用 `minDurationMs` 静音；失败和等待状态不受该阈值影响。权限确认会先等待 `awaitingInputDelayMs`，如果期间已经得到处理，就不会发送提醒。

## 安装

推荐从 npm 注册表安装正式版本，或安装经过验证的 `.tgz`。这两种方式都会让 npm/pnpm 安装 DSH 官方依赖 `@deepseek-ai/schemastery`，从而向 DSH 提供设置页所需的原生 volatile Config：

```powershell
dsh plugin --profile desktop add dsh-notification-hook@0.3.0
dsh plugin --profile desktop add C:\path\to\dsh-notification-hook-0.3.0.tgz
```

裸 `link:` 只适合源码开发。Node 会从链接目标的真实路径解析依赖；如果源码目录没有自己的 `node_modules`，Schemastery 就无法解析，插件会有意退回零依赖 schema。此时通知投递仍可工作，但设置页可能显示应急生成器而不是可写表单。链接前请在源码目录运行 `npm ci`，或者优先测试生成的 `.tgz`。

每次安装、升级、卸载或重新安装后都必须重启 DeepSeek Harness，并刷新设置页。DSH 会按包名缓存 Host 模块，只替换文件而不重启不会加载新实现。打开 **设置 → 内置插件 → Notifications / 任务提醒**，应能看到可编辑的设置表单。

插件行 id 是 `notify-hook`。`config.enabled: false` 会保留该行但停止监听；DSH 的行开关或 bundle 开关则会彻底卸载它。

### DSH 兼容性

peer 范围固定为 `>=0.2.0-rc.2 <0.3.0`。

| DSH 版本 | 支持情况 |
|---|---|
| `0.2.0-rc.2` | 发布生命周期完整实测 |
| 后续兼容的 `0.2.0` RC 与稳定版 `0.2.x` | peer 范围接受；CI 固定验证 `0.2.0-rc.2` |
| `0.2.1-alpha.2` | 受 npm 预发布元组规则影响，不在当前 peer 接受范围内 |
| `0.3.0` 及更高版本 | 在插件针对新宿主复测并放宽 peer 前拒绝安装 |

范围外版本表示尚未声明支持，不代表已经实测无法运行。请求适配时，请提供具体的 DSH 版本。

## 个性化设置页

正常情况下，设置页直接读取和写入 DSH Settings 命名空间。`0.3.0` 会先正确解开 DSH Remote 的结果包装，再发现命名空间或采用保存后返回的新 revision。保存发生 revision 冲突时，未保存的草稿会留在页面上，并显示错误。

页签名称、设置页和通知正文都跟随 DSH 的全局语言，插件页面不再提供第二套语言开关。DSH 的自动模式会跟随操作系统语言。旧 profile 中的 `config.locale` 仍会兼容读取，但只有 DSH 的语言命名空间不可用时才作为兜底。

| 分组 | 控件 |
|---|---|
| 事件 | 已完成、失败、等待输入 |
| 桌面通知 | 原生弹窗、提示音 |
| Webhook 目标 | 多个目标，每个目标可单独启停 |
| 高级 | 需要关注、已取消、时序、去重、子代理、HTTP 和日志选项 |

Webhook URL 默认以密码框显示，只能逐行显示；新增或删除目标后，所有 URL 会重新隐藏。界面错误和浏览器控制台日志会先删除 HTTP(S) URL，再显示或记录。

不同平台具体应该填写什么，尤其是 Telegram 的 URL 与会话 ID 获取方法，请看 **[推送平台配置说明书](docs/WEBHOOK-GUIDE.zh.md)**。

### 应急恢复生成器

YAML 生成器是故障恢复入口，不是正确安装 `0.3.0` 后的正常设置方式。只有 Settings Remote 不可用、返回畸形数据，或没有可用的 `notify-hook` 命名空间时才应出现。排查时可展开其中默认收起的“技术诊断信息”，优先重启 DSH 或重新安装插件，不要直接修改 profile 文件。正常设置页不再显示开发诊断文字。

确实需要应急恢复时，可以调整控件、复制完整配置块，再替换 profile `cordis.patch.yml` 中现有 `notify-hook` 的 `config`。同名覆盖会整体替换配置，因此生成器会输出全部字段。

## 测试通知

“发送测试通知”会执行两次真实写入：

1. 保存当前草稿并把 `testOnActivate` 设为 `true`，让 Host 通过所有已启用的桌面与 Webhook 目标投递；
2. 短暂等待后，使用第一次返回的 revision 把 `testOnActivate` 写回 `false`。

如果第二次写入失败，界面会故意保留打开状态并提示“取消测试状态失败”。请手动关闭 **Test on activate / 激活时测试**，然后保存，避免下次重载再次发送。

## 配置

每个字段都是可选的，推荐配置如下：

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

### Webhook 目标

请在服务商管理后台创建 Webhook，再直接粘贴到设置页的遮罩输入框。不要把真实 URL、机器人 token、Authorization 请求头或请求体放进 Issue、截图、示例或日志。

```yaml
webhooks:
  - name: project-chat
    enabled: true
    type: auto
    url: <服务商 Webhook URL>

  - name: telegram
    enabled: false
    type: telegram
    url: <Telegram 机器人接口>
    chatId: '<会话 id>'

  - name: internal
    type: generic
    url: <HTTPS 接口>
    headers:
      authorization: <密钥>
```

`type: auto` 会从 URL 识别飞书、企业微信、Telegram、Discord 和 Slack；通用接口可以显式使用 `generic`。单个目标失败不会阻止其它目标。请求使用有界超时与重试、不跟随重定向、请求体上限 64 KiB，并且日志只记录脱敏后的目标 URL。

### 桌面通知

| 系统 | 机制 |
|---|---|
| Windows | `powershell.exe` 发送 WinRT toast，失败后回退到 `msg.exe` |
| macOS | `osascript` 通知 |
| Linux | `notify-send` |

进程使用参数数组启动，绝不经过 shell；来自会话的文字会按目标平台转义。

## 开发与验证

投递逻辑只使用 `node:*` 内置模块和项目本地文件：没有 `node-notifier`、HTTP 客户端、额外 UI 框架、构建步骤或打包器。唯一直接运行时依赖是 DSH 官方组件 `@deepseek-ai/schemastery`，用于提供可写的设置命名空间；浏览器端使用 DSH 已提供的 React。

```powershell
npm ci
npm run check
npm run verify:package -- --out-dir dist
npm run verify:dsh -- --archive-dir dist
node tools/selftest.mjs --no-desktop
node tools/selftest.mjs --desktop-only
npm pack --dry-run --json
```

`verify:package` 会对真实候选包执行打包、秘密扫描、空白安装和导入；`verify:dsh` 会在带所有权标记的临时 profile 中安装固定版本的 DSH 与 pnpm，并验证安装、file specifier 替换、配置组合、卸载和重装。回环自检不会访问外部服务；桌面专项自检会有意显示三条真实系统通知。

维护者进行首次 npm 引导或常规 OIDC 发布时，请遵循 [docs/RELEASING.md](docs/RELEASING.md)。

## 排查

| 现象 | 检查 |
|---|---|
| 出现应急生成器 | 展开“技术诊断信息”，重启 DSH，再查看 Remote 结果 |
| 保存提示冲突 | 保留草稿，刷新/重新加载命名空间后再保存 |
| 测试开关保持开启 | 手动关闭 `testOnActivate` 并保存 |
| 没有收到通知 | 查看已脱敏的 `[notify-hook]` 投递摘要和每个目标的启用开关 |
| 很快完成的任务没有提醒 | 调低 `minDurationMs` 或设为 `0` |
| 桌面通知失败 | 检查系统通知权限和上表对应的系统命令 |

Telegram 会话 ID、各平台权限等专项问题，请查阅 **[推送平台配置说明书](docs/WEBHOOK-GUIDE.zh.md)**。

## 反馈问题

这是一个早期社区项目。自动检查覆盖 Windows、macOS 和 Linux 的打包与生命周期行为；实际桌面通知还依赖系统通知权限和可用的系统命令。

遇到问题可以提交 [安装问题](https://github.com/cyrillee0413-bit/dsh-notification-hook/issues/new?template=installation.md) 或 [通知问题](https://github.com/cyrillee0413-bit/dsh-notification-hook/issues/new?template=notification.md)。请提供系统、DSH 版本、插件版本和脱敏后的错误信息。分享日志或截图前，请删除机器人 Token、Webhook URL、Authorization 请求头及私密任务内容。

## 许可证

MIT，详见 `LICENSE`。
