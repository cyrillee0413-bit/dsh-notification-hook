# 推送平台配置说明书

本文说明如何把任务提醒发送到桌面、Telegram、飞书、企业微信、Discord、Slack 或自建 HTTP 接口。

## 设置页里的字段

打开 **DSH 设置 → 内置插件 → 任务提醒 → 推送目标**，然后添加目标：

| 字段 | 怎么填 |
|---|---|
| 名称 | 仅供你识别，例如“手机 Telegram”或“项目群” |
| 类型 | 推荐直接选择对应平台；“自动识别”会按 URL 判断平台 |
| Webhook 地址 | 平台生成的完整地址；它通常包含密钥，请勿公开 |
| 会话 ID | 仅 Telegram 需要；其他平台不填写 |
| 推送到该目标 | 关闭时保留配置，但不会发送 |

配置后先点击 **保存**，再点击 **发送测试通知**。一次测试会向桌面和所有已启用的目标发送真实消息。

## 桌面通知

打开“弹出桌面通知”后无需填写 URL。Windows 使用系统通知，macOS 使用通知中心，Linux 需要系统中存在 `notify-send`。

如果测试显示已发送但没有弹窗：

1. 检查系统是否允许 DeepSeek Harness、PowerShell 或终端发送通知；
2. 检查“勿扰模式/专注模式”；
3. 确认插件的“弹出桌面通知”已打开；
4. Windows 可在“设置 → 系统 → 通知”中检查通知权限。

## Telegram

Telegram 与其他平台不同，需要同时填写 Bot API 地址和 Chat ID。

1. 在 Telegram 找到 `@BotFather`，发送 `/newbot`，按提示创建机器人并保存 token。
2. 私聊机器人时先发送 `/start`；要发到群组时，把机器人加入群组，并在群里发送 `/start@你的机器人用户名` 这类明确发给机器人的命令。Telegram 默认隐私模式下，普通群消息未必会传给机器人。
3. 在浏览器打开下面的地址，把 `<TOKEN>` 替换为真实 token：

   ```text
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```

4. 在返回的 JSON 中找到最新消息的 `message.chat.id`。群组 ID 通常是负数，必须连同负号一起复制。
5. 在插件中填写：

   | 字段 | 值 |
   |---|---|
   | 类型 | `Telegram` |
   | Webhook 地址 | `https://api.telegram.org/bot<TOKEN>/sendMessage` |
   | 会话 ID | 上一步得到的 `message.chat.id` |

如果 `getUpdates` 没有消息，先私聊机器人发送 `/start`，或在目标群发送 `/start@你的机器人用户名`。如果机器人已经配置了接收更新的 webhook，Telegram 不允许同时使用 `getUpdates`；需要暂时移除该 webhook，或从你现有的机器人程序日志中取得 Chat ID。

## 飞书

1. 打开目标飞书群，进入群设置。
2. 进入“群机器人/Bots”，添加“自定义机器人”。
3. 设置机器人名称并复制生成的 Webhook 地址。
4. 在插件中选择 `飞书`（也可选“自动识别”），粘贴地址；不要填写会话 ID。

本插件当前发送普通文本消息，不会生成飞书“签名校验”的时间戳与签名。若开启了关键词规则，通知正文必须包含所设关键词；若开启签名、IP 白名单等安全限制，平台可能拒绝请求。首次配置建议先使用不需要签名的 Webhook 完成测试，再按组织要求调整。

## 企业微信

1. 打开目标企业微信群，进入群设置。
2. 选择“群机器人 → 添加机器人”。
3. 复制机器人 Webhook 地址，通常类似：

   ```text
   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
   ```

4. 在插件中选择 `企业微信`（也可选“自动识别”），粘贴完整地址；不要填写会话 ID。

机器人必须仍在目标群内，且 URL 中的 `key` 必须有效。

## Discord

1. 打开服务器设置，进入 **Integrations → Webhooks**。
2. 新建 Webhook，选择接收通知的频道。
3. 点击 **Copy Webhook URL**。
4. 在插件中选择 `Discord`（也可选“自动识别”），粘贴地址；不要填写会话 ID。

请使用 Discord 原始 Webhook 地址，不要自行添加 `/github` 等兼容模式后缀。你需要拥有管理该频道 Webhook 的权限。

## Slack

1. 创建或打开一个 Slack App。
2. 打开 **Incoming Webhooks** 并启用它。
3. 点击 **Add New Webhook to Workspace**，选择目标频道并授权。
4. 复制 `https://hooks.slack.com/services/...` 地址。
5. 在插件中选择 `Slack`（也可选“自动识别”），粘贴地址；不要填写会话 ID。

如果目标频道是私有频道，安装 App 的成员和 App 本身都必须有相应访问权限。

## 通用 JSON Webhook

选择 `自定义 JSON`，填写能接收 HTTP `POST` 的地址。插件发送 `Content-Type: application/json`，请求体形状如下：

```json
{
  "source": "dsh-notification-hook",
  "event": "completed",
  "statusLabel": "已完成",
  "title": "DSH · 已完成",
  "body": "任务名称和耗时",
  "text": "DSH · 已完成\n任务名称和耗时",
  "sessionId": "...",
  "sessionTitle": "...",
  "cwd": "...",
  "durationMs": 12345,
  "toolName": "",
  "errorCode": "",
  "errorMessage": "",
  "at": "2026-10-10T00:00:00.000Z"
}
```

当前设置页不编辑自定义请求头。如自建接口需要 `Authorization` 等请求头，请在 profile 的 `cordis.patch.yml` 对应目标下手动添加：

```yaml
webhooks:
  - name: internal
    enabled: true
    type: generic
    url: https://example.com/dsh-notify
    headers:
      Authorization: Bearer <secret>
```

## 常见问题

| 现象 | 优先检查 |
|---|---|
| 测试提示成功，但某个平台没收到 | 该目标是否启用、URL 是否完整、平台侧机器人是否仍有效 |
| Telegram 返回 400 | Chat ID 是否填写；机器人是否已加入目标群；群组 ID 的负号是否遗漏 |
| 返回 401/403 | token、Webhook 密钥、频道权限或平台安全规则 |
| 返回 404 | URL 复制不完整、已被删除，或 Telegram URL 不是 `/sendMessage` |
| 返回 429 | 平台限流；稍后重试并避免频繁测试 |
| 超时或网络错误 | 防火墙、代理、DNS，以及本机是否能访问该服务 |
| 任务完成但没有自动提醒 | “已完成”开关、最短任务时长，以及是否属于被排除的子代理会话 |

Webhook URL 和 Telegram token 都等同于密码。不要把真实值放进截图、Issue、聊天记录或公开仓库；泄露后请立即在平台侧撤销并重新生成。

## 官方参考

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [飞书自定义机器人使用指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)
- [企业微信群机器人文档](https://developer.work.weixin.qq.com/document/path/91770)
- [Discord：Intro to Webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)
- [Slack：Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
