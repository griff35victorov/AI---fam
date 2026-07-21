# Telegram Relay

Small Cloudflare Worker-compatible relay for Telegram webhooks.

## Why it exists

Timeweb remains the core runtime for the family orchestrator, PostgreSQL, S3,
and AI routing. The relay only stabilizes Telegram ingress:

1. Telegram sends an update to the relay.
2. The relay validates the Telegram webhook secret for the selected bot.
3. The relay forwards the same update to Timeweb.
4. If Timeweb answers quickly, the relay returns that response to Telegram.
5. If Timeweb is slow or unreachable, the relay returns a neutral fast
   acknowledgement and retries forwarding in the background.
6. Timeweb can send final AI answers back through the relay protected send API.

The relay stores Telegram bot tokens as Worker secrets only for the protected
send API. It does not store family data.

## Routes

- `/telegram/owner/webhook`
- `/telegram/daughter/webhook`
- `/telegram/teacher/webhook`
- `/telegram/owner/send`
- `/telegram/daughter/send`
- `/telegram/teacher/send`
- `/health`

## Worker Env

Set these variables in the Worker environment:

```env
TIMEWEB_APP_URL=https://griff35victorov-ai-fam-8853.twc1.net
TELEGRAM_OWNER_WEBHOOK_SECRET=replace_with_existing_owner_secret
TELEGRAM_DAUGHTER_WEBHOOK_SECRET=replace_with_existing_daughter_secret
TELEGRAM_TEACHER_WEBHOOK_SECRET=replace_with_existing_teacher_secret
TELEGRAM_OWNER_BOT_TOKEN=replace_with_owner_bot_token
TELEGRAM_DAUGHTER_BOT_TOKEN=replace_with_daughter_bot_token
TELEGRAM_TEACHER_BOT_TOKEN=replace_with_teacher_bot_token
TELEGRAM_RELAY_SECRET=replace_with_new_relay_send_secret
TELEGRAM_RELAY_UPSTREAM_SECRET=replace_with_new_relay_upstream_secret
RELAY_ACK_TEXT=Запрос получен.
TIMEWEB_RESPONSE_TIMEOUT_MS=1200
TIMEWEB_BACKGROUND_TIMEOUT_MS=5000
TIMEWEB_FORWARD_RETRIES=2
TIMEWEB_FORWARD_RETRY_DELAY_MS=250
```

Use the same webhook secrets that are already configured on the Timeweb app.
`TELEGRAM_RELAY_SECRET` protects Timeweb -> relay send calls.
`TELEGRAM_RELAY_UPSTREAM_SECRET` protects relay -> Timeweb forwarding when the
same value is configured in Timeweb.

Set these variables in the Timeweb app environment to enable final answers via
the relay:

```env
TELEGRAM_RELAY_URL=https://family-ai-telegram-relay.<your-worker-subdomain>.workers.dev
TELEGRAM_RELAY_SECRET=replace_with_new_relay_send_secret
TELEGRAM_RELAY_UPSTREAM_SECRET=replace_with_new_relay_upstream_secret
TELEGRAM_REQUIRE_WEBHOOK_SECRET=true
```

## Register Telegram Webhooks To Relay

Use the existing webhook script with `APP_PUBLIC_URL` set to the Worker public
URL:

```powershell
$env:APP_PUBLIC_URL="https://family-ai-telegram-relay.<your-worker-subdomain>.workers.dev"
npm run telegram:webhooks:set
npm run telegram:webhooks:info
```

The script will register:

- `APP_PUBLIC_URL/telegram/owner/webhook`
- `APP_PUBLIC_URL/telegram/daughter/webhook`
- `APP_PUBLIC_URL/telegram/teacher/webhook`

## Verify

```powershell
npm run test:relay
```

Then send a fresh message to each Telegram bot and check that
`pending_update_count` stays at `0`.
