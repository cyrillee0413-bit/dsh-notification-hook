# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-10

### Added

- Native desktop notifications for completed, failed, attention, cancelled, and awaiting-input task states.
- Webhook delivery for Feishu, WeCom, Telegram, Discord, Slack, and generic JSON endpoints.
- A writable DSH settings page with system-controlled English and Chinese localization.
- Provider-specific setup guides and safe test-notification controls.

### Security

- Webhook credentials are masked in the UI and redacted from transport logs.
- The shipped profile patch is network-inert until the user adds a target.

[0.3.0]: https://github.com/cyrillee0413-bit/dsh-notification-hook/releases/tag/v0.3.0
