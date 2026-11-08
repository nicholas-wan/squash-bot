# Operations

Configuration, deployment, scheduled maintenance and database upgrades in full.
The [README](../README.md) has the short version of each; the reasoning behind
the bot's behaviour is in [design.md](design.md).

- [Configuration](#configuration)
- [Deploy](#deploy)
- [Mini App response handling](#mini-app-response-handling)
- [Upgrading a live database](#upgrading-a-live-database)

## Configuration

`wrangler.toml` vars:

| Var | Meaning |
|---|---|
| `ALLOWED_CHATS` | Group ids the bot answers in. Every other chat is ignored. Empty or invalid configuration also stops maintenance; it never falls back to sweeping every stored chat |
| `DATA_CHAT_ID` | Optional. Makes every listed group share one set of bookings, rosters, history, and one tab. A storage key, not an address: it need not be a chat the bot is still in, and messages are never aimed at it unless it is also allowed |
| `OWNER`, `OWNER_NAME` | Who pays the courts. Always an admin, never billed. Set `OWNER_USER_ID` to their numeric id alongside it: a Telegram handle can be changed and then claimed by somebody else, and the id is what keeps the owner an admin and off the tab across a rename. `OWNER_USER_ID` is read as an alias when `OWNER` is unset |
| `DEFAULT_PLAYERS` | Seated on every new booking, never billed. Use `123456789:@handle` for takeover-resistant identity; a username alone is provisional until first contact |
| `UNBILLED_PLAYERS` | Never billed, but not seated automatically. Use the same numeric-id form |
| `DEFAULT_CAPACITY` | Players per court before an admin opens more (default 3) |
| `PUBLIC_HOLIDAYS` | Optional `YYYY-MM-DD` list replacing the built-in one |
| `TAB_NOTICE_MIN` | Optional. Balance in dollars from which the monthly tab notice is queued (default 20) |
| `TAB_NOTICE_FALLBACK_DAY` | Optional. Day of the month from which a notice nobody has collected by posting is sent blind (default 7; 0 turns the blind send off) |
| `DEFAULT_TIMEZONE` | Defaults to `Asia/Singapore` |
| `MINI_APP_URL` | Optional. The Mini App's direct link from BotFather (`/newapp`), e.g. `https://t.me/<bot>/manage`. When set, the pinned board gets a ⚙️ Manage button that opens the app over the chat. Register the app with the URL `https://<your-worker>/app/` |

The D1 database is bound as `DB`. Secrets: `BOT_TOKEN`, `WEBHOOK_SECRET`
(letters, numbers, `_`, `-` only), and `ADMIN_SECRET`. Promoting the bot can
convert a basic group to a supergroup, which changes its id — `npx wrangler tail`
logs the id of any chat the bot ignores.

## Deploy

Requirements: Telegram bot, Cloudflare Workers, and D1.

1. In BotFather, disable Group Privacy with `/setprivacy`.
2. Add the bot to each group as an admin with Pin Messages and Delete Messages.
3. Install, configure `wrangler.toml`, and ship:

```powershell
npm install
Copy-Item wrangler.example.toml wrangler.toml
npx wrangler login
npx wrangler d1 create squashbot-eu --location weur
```

The location hint matters: Telegram delivers webhooks from Amsterdam, so the
Worker executes there, and a database in another region charges every query a
cross-region round trip — measured at ~200ms each while this one lived in APAC.
The Mini App is the exception: its requests come from members' phones, so
without help the Worker ran in Singapore and paid that round trip on every
query and Telegram call. `[placement] region = "gcp:europe-west4"` in
`wrangler.toml` pins it beside the database and Telegram for every request;
the `cf-placement` response header shows where a request ran.
The retired APAC database is gone; `backup-20260817.sql` is the pre-migration
snapshot.

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

The every-minute cron first reads one persisted next-due timestamp. Idle ticks
skip the maintenance sweep and draft cleanup, while still updating the health
heartbeat. Due times come from existing court reminders, starts and ends,
message/draft cleanup, and retries. Midnight refreshes relative date labels;
9am queues monthly tab notices, which the debtors' own next posts deliver,
and from the fallback day sends the uncollected ones blind. Database triggers invalidate the cached deadline
when bookings, rosters or other scheduled work change, so edits cannot leave a
stale wake-up time. Changes during a sweep get a follow-up pass the next minute;
failures also retry then. Interactive Join and booking actions still update
their messages immediately. This reduces database work, not cron invocations.

The first answer to every button tap rides back on the webhook's own HTTP
response (Bot API, "Making requests when getting updates") instead of a
separate round trip, and each tap logs its colo and duration — one line in
`npx wrangler tail` — so "is it slow" is always answerable with a number.

A tap answers as soon as its own change is saved; the pinned board, the tab,
roster notices and receipts follow it. A court's reminders go out together,
finished messages are cleared six at a time, and redraws of one message run one
at a time, with a burst of requests sharing the one that is waiting. A private
message cut off by the fifteen-second bound may have arrived, so it is never
sent again or repeated in the group, and a short Telegram rate limit is waited
out once. `node bench/latency.mjs` prints the round trips behind each common
flow, and `test/speed.test.js` pins them.

The root URL is a health check: 200 while a fully successful every-minute
maintenance tick is fresh. A failed reminder, board, notice, cleanup, charging,
or database stage withholds the success heartbeat; the URL turns 500 once the
last successful pass is five minutes old —
point any uptime pinger at it. `npm run deploy` refuses to ship a red test
suite; every Telegram call is bounded at fifteen seconds so a stalled fetch
fails loudly instead of dying silently with the isolate.

## Group wallpaper

`assets/squash-group-wallpaper.png` (1440×3120) is the group's chat
wallpaper: a calm dark field with a warm floor glow, a teal glass-wall glow and
only the court's T in faint red, kept low-contrast so busy chats stay readable.
It is rendered from `images/projects/squash-wallpaper.svg` in the website repo
and dithered so the dark gradients do not band. Bots cannot set wallpapers: a
group admin sets it under Edit > Appearance > Wallpaper, which Telegram only
offers once the group has enough boosts.

## Mini App response handling

The opening court list reads the courts, rosters and timezone while Telegram
checks membership. Nothing is returned to a non-member; admin-only lookups
wait for the role check. Role changes and join/leave updates clear the local
cache, writes recheck answers older than 30 seconds, and a membership lookup
times out after four seconds. The page retries a membership 503 twice.
Re-run `/setup` after deploying this version so the webhook requests
`chat_member` updates.

Join and Leave read and change the live court in one conditional D1 batch,
checking the start time, chat, current capacity and numeric player identity.
Saved payments, undos and roster changes answer before starting the pinned
redraws and private notices. Toasts confirm the saved change without claiming
that a later notice has arrived. Failed cleanup records or identity-link
redraws are logged; identity ownership writes themselves still fail closed.

Returning to a visible app refreshes its current screen without replacing an
open booking form. Telegram 6.1+ uses the native MainButton to save a booking;
older clients and browser preview keep the page button. Unsaved form changes
prompt before Back or Close, with Telegram closing confirmation on 6.2+.
The booking form opens the sheet to full height, and moving its start time
carries the finish with it, keeping the length and stopping at 10pm. Its court
box takes a number, a letter or a name, read the way the chat's typed court
is, so a court saved in chat as a name can still be edited here. A request
that has not answered in fifteen seconds is given up with a toast, and the
screen is asked again in case a write landed; an error page with no message
of ours still says something went wrong.

## Upgrading a live database

`npm run db:init` runs `schema.sql`, which is entirely `IF NOT EXISTS`: safe on a
live database, and it creates every table and index. What it cannot do is add a
column to a table that already exists, so an existing database also needs the
migrations, or the pinned board and every new booking fail at runtime:

```powershell
npm run db:init
npm run db:migrate:002
npm run db:migrate:003
npm run db:migrate:004
npm run db:migrate:005
npm run db:migrate:006
npm run db:migrate:007
npm run db:migrate:008
npm run db:migrate:009
npm run db:migrate:010
npm run db:migrate:011
npm run db:migrate:012
npm run db:migrate:013
npm run db:migrate:014
npm run db:migrate:015
npm run db:migrate:016
npm run db:migrate:017
npm run db:migrate:018
npm run db:migrate:019
npm run db:migrate:020
npm run db:verify
```

Run them in that order. Everything the migrations used to create now lives in
`schema.sql`, leaving 002, 003, 005, 006, and 016 (free courts) as `ALTER TABLE` alone, 004 as a
no-op, and 007–013, 015 and 017 (pending `/debt` drafts) as idempotent
table/index/trigger migrations. 018 replaces the alias-claim trigger, which
`schema.sql` cannot do on a live database because its triggers are
`IF NOT EXISTS`: the old one left a handle's charge behind when the same court
was also billed to the verified id. It also adds the tab-notice index and
moves any such leftover onto the id. 019 adds the index that finds your own
tab by numeric id; `schema.sql` creates it too, so on a live database either
one is enough. 020 only adds indexes (and swaps the ledger's slug index for
a wider one), so it is safe to run at any time. 015
adds the table that records every Telegram update id once, so an update
Telegram redelivers is answered and dropped rather than handled twice — the
guard that keeps a redelivered `/debt` from writing a second row. 014 replaces
the per-booking announcement tables with the one-per-group notice: it hands any
message the old tables still track to the message cleanup sweep, then drops
them, so on a database past 014 the 010 and 011 files would recreate empty
tables and must not be re-run. The split exists
because `wrangler d1 execute --file` is atomic: one failed statement rolls the
whole file back, so a `CREATE` sharing a file with an `ALTER` would be skipped on
a re-run rather than applied. That is what makes a re-run harmless — an already
applied migration fails whole with `duplicate column name`, having had nothing
else to lose, and the next file can still be run.

`npm run db:verify` prints `schema_ok` once every migrated column is present, and
otherwise fails naming the one that is missing. It is worth running because that
same atomicity can leave a hand-patched database short: a file whose first
`ALTER` duplicates rolls back the later ones too, and they are never retried.

