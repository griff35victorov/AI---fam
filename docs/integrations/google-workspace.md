# Google Workspace: Gmail and Calendar

This integration connects the family orchestrator to the owner's Google Calendar and Gmail through the official Google REST APIs.

Current mode is read-only:

- Calendar: list upcoming events.
- Gmail: search/list message metadata and snippets.
- Daily briefing: include calendar events and recent mail.

Write actions are intentionally not enabled yet. Creating events, sending mail, or drafting mail must be added as a separate provider with explicit user confirmation.

## Required Timeweb Environment Variables

Add these variables to the App Platform service and redeploy/restart it:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
GOOGLE_WORKSPACE_ALLOWED_ROLES=owner
GOOGLE_API_TIMEOUT_MS=8000
GOOGLE_CALENDAR_ENABLED=true
GOOGLE_CALENDAR_ID=primary
GOOGLE_CALENDAR_MAX_EVENTS=10
GOOGLE_GMAIL_ENABLED=true
GOOGLE_GMAIL_USER_ID=me
GOOGLE_GMAIL_DEFAULT_QUERY=newer_than:7d
GOOGLE_GMAIL_MAX_MESSAGES=5
```

Do not add your Google password. The app needs an OAuth refresh token only.

## OAuth Scopes

Use the minimum scopes for the first connection:

```text
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/gmail.readonly
```

## Getting the Refresh Token

Create an OAuth client in Google Cloud and add this redirect URI to it:

```text
http://127.0.0.1:53682/oauth2callback
```

Then run locally from the repository:

```powershell
$env:GOOGLE_CLIENT_ID="your-client-id"
$env:GOOGLE_CLIENT_SECRET="your-client-secret"
npm run google:oauth
```

Open the printed URL, grant access, and copy the printed `GOOGLE_REFRESH_TOKEN` into Timeweb App Platform environment variables.

## Telegram Checks

After the variables are set and the app is restarted, test from the owner bot:

```text
Что у меня в календаре завтра?
Покажи непрочитанные письма
Сделай утреннюю сводку
/tools
```

Expected result: `calendar_scheduling` and `email_triage` are shown as connected, and the bot answers through Google Calendar/Gmail without falling back to a generic AI answer.
