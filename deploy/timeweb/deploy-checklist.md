# Deployment Checklist

- [ ] GitHub repository exists: `griff35victorov/family-ai-orchestrator`.
- [ ] App Platform project is connected to `main`.
- [ ] PostgreSQL DBaaS is created.
- [ ] S3 private bucket is created.
- [ ] Timeweb AI Agent/API key is created.
- [ ] Environment variables are configured.
- [ ] Database migrations run successfully.
- [ ] `/health` returns `ok`.
- [ ] Telegram webhook is configured.
- [ ] Allowed Telegram user can send `/start`.
- [ ] Test owner request is routed.
- [ ] Test teacher request is routed.
- [ ] Test child request is routed.
- [ ] Reminder job sends a test reminder.
- [ ] Backups are enabled.
- [ ] Daily/monthly AI budgets are configured.
