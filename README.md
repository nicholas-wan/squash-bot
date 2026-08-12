# SquashBot

Telegram group bot for tracking squash court bookings on one pinned board.

```text
13 Aug Court 4 9pm
court four tomorrow at 9pm
Friday 9pm-10:30pm, Court 2
tmr c4 2100
```

Clear bookings are added immediately. Missing or ambiguous details open an
inline wizard for the requester to choose or type the date, court, and time,
then confirm before saving. A missing end time defaults to one hour.

The pinned board uses NagBot-style countdowns (`today`, `tomorrow`, or
`in N days`), with buttons to add and manage bookings. It does not display who
created a booking or written add/cancel instructions. Cancellation requires a
button confirmation.

SquashBot sends an 8am same-day reminder (or one hour before early bookings),
removes expired slots, and deletes the pinned board when no bookings remain.

## Commands

```text
/book [details]  Add a booking or open a blank form
/courts         Refresh the pinned board
/cancel ID      Remove a booking
/help           Show examples
```

Recognized command messages are deleted immediately when the bot has Delete
Messages permission. Pinned-board buttons are the preferred group interface.

## Deploy

Requirements: Telegram bot, Cloudflare Workers, and D1.

1. In BotFather, disable Group Privacy with `/setprivacy`.
2. Add the bot to the group as an admin with Pin Messages and Delete Messages.
3. Install and configure the project:

```powershell
npm install
Copy-Item wrangler.example.toml wrangler.toml
npx wrangler login
npx wrangler d1 create squashbot
```

Put the returned D1 ID and the Telegram group ID in `wrangler.toml`, then run:

```powershell
npm run db:init
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_SECRET
npm test
npm run deploy
```

Register the webhook and command menu:

```powershell
curl.exe -X POST -H "Authorization: Bearer YOUR_ADMIN_SECRET" `
  https://YOUR-WORKER.workers.dev/setup
```

`WEBHOOK_SECRET` must contain only letters, numbers, underscores, or hyphens.
The default timezone is `Asia/Singapore`.
