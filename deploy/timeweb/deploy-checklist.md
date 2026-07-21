# Deployment Checklist

- [x] GitHub repository exists: `griff35victorov/AI---fam`.
- [x] App Platform project is connected to `main`.
- [x] PostgreSQL DBaaS is created.
- [ ] S3 private bucket is created.
- [ ] Timeweb AI Agent/API key is created.
- [ ] Production environment variables are fully configured.
- [x] Database migrations run successfully.
- [x] `/health` returns `ok`.
- [ ] Family Telegram users are bootstrapped into PostgreSQL.
- [ ] Telegram webhook is configured.
- [ ] Allowed Telegram user can send `/start`.
- [ ] Test owner request is routed.
- [ ] Test teacher request is routed.
- [ ] Test child request is routed.
- [ ] Reminder job sends a test reminder.
- [ ] Backups are enabled.
- [ ] Daily/monthly AI budgets are configured.
