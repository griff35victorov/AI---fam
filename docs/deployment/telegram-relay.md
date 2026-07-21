# Telegram Relay Deployment

## Decision

Keep the family orchestrator core in Timeweb App Platform:

- PostgreSQL DBaaS
- S3 materials
- Timeweb AI agents
- family authorization and role routing

Move only Telegram transport to a tiny relay. The relay can be deployed in two
ways:

1. **Recommended fastest path:** Cloudflare Worker.
2. **Timeweb-only path:** Timeweb Cloud Server with Node.js + Nginx/Caddy HTTPS.

Do not deploy the relay as a second App Platform app to solve the current
Telegram timeout issue. App Platform is still suitable for the core API, but the
observed failure is on Telegram -> App Platform ingress.

## Why This Matches The Docs

Timeweb App Platform is designed for automatic deploy from repositories and
Docker Compose, and it can use runtime variables and a free technical SSL
domain:

- https://timeweb.cloud/docs/apps
- https://timeweb.cloud/docs/apps/deploying-with-docker-compose
- https://timeweb.cloud/docs/apps/variables

Timeweb Cloud Server gives full root access over the machine and network path:

- https://timeweb.cloud/docs/cloud-servers
- https://timeweb.cloud/docs/cloud-servers/manage-servers/create-server
- https://timeweb.cloud/docs/cloud-servers/servers-start

Telegram webhooks require HTTPS and support ports 443, 80, 88, and 8443. They
also support `secret_token`, which Telegram sends back as
`X-Telegram-Bot-Api-Secret-Token`, and a bot method can be returned directly in
the webhook HTTP response:

- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#making-requests-when-getting-updates
- https://core.telegram.org/bots/faq

## Current Relay Code

- Worker-compatible entrypoint: `apps/telegram-relay/src/worker.js`
- Node server entrypoint: `apps/telegram-relay/src/node-server.js`
- Tests: `apps/telegram-relay/test/*.test.js`

Routes:

- `GET /health`
- `POST /telegram/owner/webhook`
- `POST /telegram/daughter/webhook`
- `POST /telegram/teacher/webhook`
- `POST /telegram/owner/send`
- `POST /telegram/daughter/send`
- `POST /telegram/teacher/send`

## Required Secrets

Use real values only in provider env/secret settings, never in Git.

Relay environment:

```env
TIMEWEB_APP_URL=https://griff35victorov-ai-fam-8853.twc1.net
TELEGRAM_OWNER_WEBHOOK_SECRET=...
TELEGRAM_DAUGHTER_WEBHOOK_SECRET=...
TELEGRAM_TEACHER_WEBHOOK_SECRET=...
TELEGRAM_OWNER_BOT_TOKEN=...
TELEGRAM_DAUGHTER_BOT_TOKEN=...
TELEGRAM_TEACHER_BOT_TOKEN=...
TELEGRAM_RELAY_SECRET=...
TELEGRAM_RELAY_UPSTREAM_SECRET=...
RELAY_ACK_TEXT=Запрос получен.
TIMEWEB_RESPONSE_TIMEOUT_MS=1200
TIMEWEB_BACKGROUND_TIMEOUT_MS=5000
TIMEWEB_FORWARD_RETRIES=2
TIMEWEB_FORWARD_RETRY_DELAY_MS=250
```

Timeweb App Platform core environment:

```env
TELEGRAM_REQUIRE_WEBHOOK_SECRET=true
TELEGRAM_RELAY_URL=https://<relay-public-domain>
TELEGRAM_RELAY_SECRET=...
TELEGRAM_RELAY_UPSTREAM_SECRET=...
```

## Option A: Cloudflare Worker

Use this when the priority is to stabilize Telegram quickly.

1. Create a Cloudflare Worker.
2. Upload or connect `apps/telegram-relay/src/worker.js`.
3. Add all relay env/secrets listed above.
4. Check `https://<worker-domain>/health`.
5. Set `APP_PUBLIC_URL=https://<worker-domain>` locally.
6. Run:

```powershell
npm run telegram:webhooks:set
npm run telegram:webhooks:info
```

7. Add `TELEGRAM_RELAY_URL=https://<worker-domain>` and relay secrets to the
   Timeweb App Platform app, then redeploy the core.
8. Send test messages to all three bots.

## Option B: Timeweb Cloud Server

Use this when the priority is to keep the transport inside Timeweb.

Needed from the owner:

- confirmation to create a paid Cloud Server
- server IP or SSH access after creation
- a domain/subdomain that can point to the server

The public Timeweb pricing page currently shows Moscow cloud server options
starting from `Cloud MSK 40` at `882 ₽/мес` for 1-month billing; confirm the
final price in the panel before ordering:

- https://timeweb.cloud/services/cloud-servers

Server setup outline:

```bash
apt update
apt install -y git nodejs npm nginx certbot python3-certbot-nginx
git clone <repo-url> /opt/family-ai-orchestrator
cd /opt/family-ai-orchestrator
npm ci --omit=dev --ignore-scripts
```

Create `/opt/family-ai-orchestrator/.env.relay` with the relay environment
variables.

Create a systemd unit:

```ini
[Unit]
Description=Family AI Telegram Relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/family-ai-orchestrator
EnvironmentFile=/opt/family-ai-orchestrator/.env.relay
Environment=PORT=8787
ExecStart=/usr/bin/npm run relay:start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Then:

```bash
systemctl daemon-reload
systemctl enable family-ai-telegram-relay
systemctl start family-ai-telegram-relay
```

Nginx reverse proxy:

```nginx
server {
  server_name relay.example.ru;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

Issue HTTPS certificate:

```bash
certbot --nginx -d relay.example.ru
```

Timeweb docs for related server steps:

- Server start and SSH: https://timeweb.cloud/docs/cloud-servers/servers-start
- DNS records/subdomains: https://timeweb.cloud/docs/domains/dns-records-management
- Nginx SSL: https://timeweb.cloud/docs/unix-guides/ustanovka-ssl-na-nginx
- Background process patterns: https://timeweb.cloud/docs/unix-guides/zapusk-bota-v-fonovom-rezhime

After HTTPS works:

```powershell
$env:APP_PUBLIC_URL="https://relay.example.ru"
npm run telegram:webhooks:set
npm run telegram:webhooks:info
```

Set the same relay URL and relay secrets in Timeweb App Platform, redeploy the
core, then test all three bots.

## Verification Checklist

1. `GET /health` on relay returns `{ "ok": true }`.
2. `npm run telegram:webhooks:info` shows relay URLs.
3. `pending_update_count` stays `0` after fresh messages.
4. User receives immediate acknowledgement.
5. User receives final AI answer as a second Telegram message.
6. Timeweb logs do not show direct Telegram `sendMessage` timeout.
7. Secret scan remains clean before pushing.
