<p align="center">
  <img src="assets/squashbot-logo.png" alt="SquashBot logo" width="220">
</p>

<h1 align="center">SquashBot</h1>

Telegram group bot that keeps squash court bookings on one pinned board.

```text
13 Aug Court 4 9pm
court four tomorrow at 9pm
Friday 8pm-9:30pm, Court 2
tmr c4 2100
```

Anything missing or ambiguous is asked with buttons rather than guessed, and
nothing is saved until it is confirmed. No end time means one hour. Courts run
**7am to 10pm**, so 9pm is the last slot. Overlaps on the same court are blocked
unless the requester reviews the conflict and chooses **Add anyway**. Every add,
edit, and delete keeps an audit snapshot with the actor and the original text.

## The board

```text
in 5 days · Mon 17 Aug · 9pm · Court 4
👥 @nicholaswan, @Dodgerblueee · 1 slot
```

**🙋 Join** opens a private court list: Join for courts you are not on, Leave for
the ones you are. **⚙️ Manage** edits the date, court, or time, deletes a
booking, and lets group admins open extra slots (up to twelve) or take a player
off. The roster locks once a court starts.

Every booking seats `DEFAULT_PLAYERS` plus whoever booked it. Players are keyed
on their Telegram username, so someone named in config is the same person who
later taps a button; anyone without a username is keyed on their numeric id.

## Money

| When | Rate |
|---|---|
| From 6pm, weekends, Singapore public holidays | $6/hour |
| Otherwise | $3/hour |

The court is split evenly across the roster once it has been played, so a
cancelled booking — or a no-show an admin removes in time — is never billed.
`OWNER`, `DEFAULT_PLAYERS`, and `UNBILLED_PLAYERS` play free, and the organiser
absorbs the rounding remainder.

A second pinned message lists who owes the organiser. Group admins clear a
balance from it, which appends a payment to the ledger rather than erasing
anything. It unpins itself once everyone is settled.

The 2026 holiday list in `src/pricing.js` should be checked against mom.gov.sg
each December, or overridden with `PUBLIC_HOLIDAYS`.

## Privacy

Nothing SquashBot sends is addressed to the group. Commands, forms, receipts,
reminders, and errors are ephemeral: only the recipient and the bot see them.
Booking by message deletes the message, and the booker gets a private receipt
with an **OK** button. The pinned board and the tab are the only shared
messages, so a new booking is discovered there rather than announced.

Each player is reminded two hours before their court and again at 8am on the
day. Reminders and receipts clear themselves at the end of the day they are
about. Telegram does not guarantee ephemeral delivery when the recipient is
offline; if it refuses, one public reminder is sent instead of one per player.

## Commands

```text
/book [details]  Add a booking or open a blank form
/courts          Refresh the pinned board
/tab             Refresh the pinned money tab
/cancel ID       Remove a booking
/help            Show examples
```

## Configuration

`wrangler.toml` vars:

| Var | Meaning |
|---|---|
| `ALLOWED_CHATS` | Group ids the bot answers in. Every other chat is ignored |
| `DATA_CHAT_ID` | Optional; one of the above. Makes every listed group share one set of bookings, rosters, history, and one tab. Each group keeps its own pinned messages |
| `OWNER`, `OWNER_NAME` | Who pays the courts. Always an admin, never billed |
| `DEFAULT_PLAYERS` | Seated on every new booking, never billed |
| `UNBILLED_PLAYERS` | Never billed, but not seated automatically |
| `DEFAULT_CAPACITY` | Players per court before an admin opens more (default 3) |
| `PUBLIC_HOLIDAYS` | Optional `YYYY-MM-DD` list replacing the built-in one |
| `DEFAULT_TIMEZONE` | Defaults to `Asia/Singapore` |

Secrets: `BOT_TOKEN`, `WEBHOOK_SECRET` (letters, numbers, `_`, `-` only), and
`ADMIN_SECRET`. Promoting the bot can convert a basic group to a supergroup,
which changes its id — `npx wrangler tail` logs the id of any chat the bot
ignores.

## Deploy

Requirements: Telegram bot, Cloudflare Workers, and D1.

1. In BotFather, disable Group Privacy with `/setprivacy`.
2. Add the bot to each group as an admin with Pin Messages and Delete Messages.
3. Install, configure `wrangler.toml`, and ship:

```powershell
npm install
Copy-Item wrangler.example.toml wrangler.toml
npx wrangler login
npx wrangler d1 create squashbot
```

```powershell
npm run db:init
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_SECRET
npm test
npm run deploy
```

Register the webhook and command menu, and optionally the profile photo:

```powershell
curl.exe -X POST -H "Authorization: Bearer YOUR_ADMIN_SECRET" `
  https://YOUR-WORKER.workers.dev/setup
```

```powershell
curl.exe -X POST -H "Authorization: Bearer YOUR_ADMIN_SECRET" `
  https://YOUR-WORKER.workers.dev/profile-photo
```

`POST /refresh` rebuilds the board and tab in every allowed chat.

## Upgrading a live database

`npm run db:init` only creates missing tables; it cannot add a column to a table
that already exists. An existing database needs the migrations, or the pinned
board and every new booking fail at runtime:

```powershell
npm run db:migrate:002
npm run db:migrate:003
npm run db:migrate:004
```

Run them in order, and run each even if an earlier one fails: an already applied
migration reports `duplicate column name` from its `ALTER TABLE` lines, which is
expected. Everything else in them is `IF NOT EXISTS`.
