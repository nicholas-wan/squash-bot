<p align="center">
  <img src="assets/squashbot-logo.png" alt="SquashBot logo" width="220">
</p>

<h1 align="center">SquashBot</h1>

Telegram group bot for tracking squash court bookings on one pinned board.

```text
13 Aug Court 4 9pm
court four tomorrow at 9pm
Friday 8pm-9:30pm, Court 2
tmr c4 2100
```

Every booking opens a private confirmation form before it is saved. Missing or
ambiguous details can be chosen or typed without guessing. A missing end time
defaults to one hour.
“Next Monday” means the nearest upcoming Monday. Original booking text is kept
with saved bookings for future auditing.

Courts run **7am to 10pm**, so the earliest slot starts at 7am and the last one
at 9pm. Anything outside those hours is refused with the reason rather than
quietly booked.

The pinned board renders two concise lines per booking, for example
`in 5 days · Mon 17 Aug · 9pm · Court 4` above
`👥 @nicholaswan, @Dodgerblueee · 1 slot`. Its buttons join or leave a booking
and add, edit, or delete them; edits can change the date, court, and time.
Destructive changes need confirmation, and labels use court/date/time instead of
internal IDs.

## Players

Every court holds three players by default, and every new booking starts with
the organiser's household from `DEFAULT_PLAYERS` plus whoever booked it. Anyone
in the group taps **🙋 Join** on the pinned board to get a private court list —
only they can see it, and it offers **Join** for courts they are not on and
**Leave** for the ones they are, so there is never a join button for a court you
already joined. The pinned board itself shows who is in and how many slots are
left. A full court turns further taps away until a Telegram group admin opens
another slot from **Manage bookings**, up to twelve. The roster locks once a
court starts, so nobody can play and then drop off to dodge their share.

Group admins can take someone off a booking from **Manage bookings → Admin:
remove a player**, right up to the end of the slot. That is also how a no-show is
kept off the tab, since shares are worked out from whoever is still on the roster
when the court expires. The person removed is told privately.

Players are keyed on their Telegram username, which is what `DEFAULT_PLAYERS`
names and what the group calls each other, so a player seeded from config is the
same person who later taps a button. Someone with no username is keyed on their
numeric id instead.

## Sharing groups

Setting `DATA_CHAT_ID` to one of the `ALLOWED_CHATS` ids makes every listed group
share one set of bookings, rosters, history, and one tab: a court booked in one
group is announced in both, appears on both pinned boards, and can be joined from
either. Each group keeps its own pinned messages. Reminders follow the player to
the group they joined from. Leave `DATA_CHAT_ID` unset and each group keeps its
own data.

## Money

Courts cost **$6 per hour** from 6pm, all day at weekends, and all day on
Singapore public holidays, and **$3 per hour** at other times. A booking that
straddles 6pm is charged at both rates. The public holiday list in
`src/pricing.js` covers 2026 and should be checked against mom.gov.sg each
December; `PUBLIC_HOLIDAYS` in `wrangler.toml` overrides it without a deploy.

`UNBILLED_PLAYERS` lists anyone else who plays for free without being added to
every booking, which is the difference between them and `DEFAULT_PLAYERS`.

The court cost is split evenly across everyone on the roster. Shares reach the
tab only after a booking has been played, so a cancelled court or a player who
left in time is never billed. The organiser's household plays free: they pay the
court, and they absorb the rounding remainder.

A second pinned message tracks who owes the organiser, and disappears once
everything is settled. Group admins mark a balance paid from that message, which
writes a payment into the append-only ledger rather than erasing anything.

Overlapping bookings on the same court are blocked atomically unless the
requester reviews the conflict and explicitly chooses **Add anyway** or **Save
anyway**. Additions, edits, and deletions keep append-only audit snapshots with
the actor and source text.

SquashBot reminds each player two hours before their booking, plus an 8am
same-day reminder (or one hour before early bookings). Reminders are posted in
the group as ephemeral messages addressed to one player at a time, so they stay
in the group chat but nobody sees a reminder for a court they are not playing on.
Reminders are deleted at the end of the day they are about, so they do not pile
up. It removes expired slots and deletes the pinned board when no bookings
remain.

## Commands

```text
/book [details]  Add a booking or open a blank form
/courts         Refresh the pinned board
/tab            Refresh the pinned money tab
/cancel ID      Remove a booking
/help           Show examples
```

When a pinned board exists, `/help` includes a button linking directly to it.

Commands and SquashBot's help, forms, private confirmations, reminders, and
errors are ephemeral: only the recipient and the bot can see them. A new booking
is the one thing announced to the group, so people know there is something to
join; edits and removals only update the pinned board. Older Telegram clients may
send commands normally; SquashBot deletes those immediately when it has Delete
Messages permission. Telegram does not guarantee ephemeral delivery when the
recipient is offline.

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

Put the returned D1 ID, the Telegram group IDs, `OWNER`, and `DEFAULT_PLAYERS` in
`wrangler.toml`, then run:

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

Update the Telegram bot profile photo from `assets/squashbot-logo.jpg`:

```powershell
curl.exe -X POST -H "Authorization: Bearer YOUR_ADMIN_SECRET" `
  https://YOUR-WORKER.workers.dev/profile-photo
```

`npm run db:init` only creates missing tables — it cannot add a column to a table
that already exists. **Upgrading an existing database means running the
migrations**, or the pinned board and every new booking will fail at runtime:

```powershell
npm run db:migrate:002
```

```powershell
npm run db:migrate:003
```

```powershell
npm run db:migrate:004
```

Run them in order, and run each one even if an earlier one fails: an already
applied migration reports `duplicate column name` from its `ALTER TABLE` lines,
which is expected. Everything else in them is `IF NOT EXISTS`.

`WEBHOOK_SECRET` must contain only letters, numbers, underscores, or hyphens.
The default timezone is `Asia/Singapore`.
