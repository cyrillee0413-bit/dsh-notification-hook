# Notification target setup guide

This guide explains how to deliver DSH task notifications to the desktop, Telegram, Feishu, WeCom, Discord, Slack, or your own HTTP endpoint.

## Fields on the settings page

Open **DSH Settings → Built-in plugins → Notifications → Webhook targets**, then add a target:

| Field | What to enter |
|---|---|
| Name | A private label such as “phone Telegram” or “project channel” |
| Type | Choose the provider; Auto-detect infers it from the URL |
| Webhook URL | The complete URL issued by the provider; treat it as a secret |
| Chat ID | Telegram only; leave it empty for every other provider |
| Deliver to this target | When off, the target is kept but receives nothing |

Click **Save**, then **Send test notification**. A test sends a real message to the desktop and every enabled target.

## Desktop notifications

Enable **Show a desktop notification**; no URL is needed. Windows uses system notifications, macOS uses Notification Center, and Linux requires `notify-send` to be available.

If the test says it was sent but no popup appears:

1. allow notifications from DeepSeek Harness, PowerShell, or your terminal in the operating system;
2. check Do Not Disturb/Focus mode;
3. confirm the desktop switch is enabled;
4. on Windows, review **Settings → System → Notifications**.

## Telegram

Telegram needs both a Bot API endpoint and a Chat ID.

1. Message `@BotFather`, send `/newbot`, follow the prompts, and keep the bot token.
2. Send `/start` to the bot in a private chat. For a group, add the bot and send an addressed command such as `/start@YourBotUsername` in that group; unlike an ordinary message, this reaches a bot using Telegram's default privacy mode.
3. Open this URL after replacing `<TOKEN>`:

   ```text
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```

4. Find `message.chat.id` in the newest update. Group IDs are often negative; copy the minus sign too.
5. Enter:

   | Field | Value |
   |---|---|
   | Type | `Telegram` |
   | Webhook URL | `https://api.telegram.org/bot<TOKEN>/sendMessage` |
   | Chat ID | the `message.chat.id` value |

If `getUpdates` is empty, first send the bot `/start` privately or send `/start@YourBotUsername` in the target group. Telegram does not allow `getUpdates` while the bot has an incoming-update webhook configured; temporarily remove that webhook or obtain the Chat ID from your existing bot application.

## Feishu

1. Open the destination group and its settings.
2. Open **Bots** and add a **Custom Bot**.
3. Name it and copy the generated webhook URL.
4. Select `Feishu` (or Auto-detect), paste the URL, and leave Chat ID empty.

This plugin sends plain text and does not generate Feishu signature timestamps or signatures. Keyword rules accept only notifications containing the configured keyword; signature and IP restrictions can reject these requests. Start with an unsigned webhook for the first test, then apply restrictions compatible with your organization.

## WeCom

1. Open the destination WeCom group and its settings.
2. Choose **Group Bot → Add bot**.
3. Copy the webhook URL, normally shaped like:

   ```text
   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
   ```

4. Select `WeCom` (or Auto-detect), paste the complete URL, and leave Chat ID empty.

The bot must remain in the group and the URL's `key` must still be valid.

## Discord

1. Open **Server Settings → Integrations → Webhooks**.
2. Create a webhook and select its destination channel.
3. Click **Copy Webhook URL**.
4. Select `Discord` (or Auto-detect), paste the URL, and leave Chat ID empty.

Use Discord's original webhook URL; do not append compatibility suffixes such as `/github`. You need permission to manage webhooks for the channel.

## Slack

1. Create or open a Slack App.
2. Open **Incoming Webhooks** and enable it.
3. Click **Add New Webhook to Workspace**, select a channel, and authorize it.
4. Copy the `https://hooks.slack.com/services/...` URL.
5. Select `Slack` (or Auto-detect), paste the URL, and leave Chat ID empty.

For a private channel, both the person installing the App and the App must have access.

## Generic JSON webhook

Choose `Custom JSON` and provide an endpoint that accepts an HTTP `POST`. The plugin sends `Content-Type: application/json` with this shape:

```json
{
  "source": "dsh-notification-hook",
  "event": "completed",
  "statusLabel": "Completed",
  "title": "DSH · Completed",
  "body": "Task name and duration",
  "text": "DSH · Completed\nTask name and duration",
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

The settings page does not edit custom headers. If your endpoint requires `Authorization` or another header, add it manually under the target in the profile's `cordis.patch.yml`:

```yaml
webhooks:
  - name: internal
    enabled: true
    type: generic
    url: https://example.com/dsh-notify
    headers:
      Authorization: Bearer <secret>
```

## Troubleshooting

| Symptom | Check first |
|---|---|
| Test reports success but one provider is silent | target enabled state, complete URL, and whether the provider-side bot still exists |
| Telegram returns 400 | Chat ID, bot membership, and a missing minus sign in a group ID |
| HTTP 401/403 | token, webhook secret, channel permissions, or provider security rules |
| HTTP 404 | incomplete/deleted URL, or a Telegram endpoint not ending in `/sendMessage` |
| HTTP 429 | provider rate limit; wait and avoid rapid tests |
| Timeout/network error | firewall, proxy, DNS, and whether the service is reachable from this computer |
| Completed tasks stay silent | Completed switch, minimum duration, and whether this is an excluded subagent session |

A webhook URL or Telegram token is effectively a password. Never put a real value in screenshots, issues, chat logs, or a public repository. Revoke and regenerate it if exposed.

## Official references

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Feishu custom bot guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)
- [WeCom group bot documentation](https://developer.work.weixin.qq.com/document/path/91770)
- [Discord: Intro to Webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)
- [Slack: Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
