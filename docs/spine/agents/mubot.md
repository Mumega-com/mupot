# mubot — the face

Node of [[MU.100.002-spine]] · roster row: [[roster]]

- **Role:** customer/team face on Telegram. Home Channel reflector (`-5317747241`), cron notifications ([[MU.100.001]] §3.1 Team Ops Face). Model: deepseek-v4-flash.
- **Structural fact:** mubot CANNOT receive SOS bus traffic directly. It is a Telegram-side reflector. Do not build SOS→mubot watchers; that layer existed (`mubot-inbox-watch.service`, webhook push, mupot#768) and is retired — disabled 2026-08-08.
- **Channel law:** ONE getUpdates poller per bot token (Telegram API). The 2026-08-08 `hadi-bridge` 409 crash-loop was two pollers fighting one bot. The Claude Code Telegram plugin is the canonical poller; legacy bridges retire — audit at `~/.fleet/evidence/cleanup-20260808/AUDIT.md`.
- **Ingress law:** group chat is mention-only; board tasks wake via board, not chat ([[MU.100.001]] §4.2).
