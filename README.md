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
in 5 days · Mon 17 Aug
9pm · Court 4 · 1 slot
```

Two short lines and a gap, because a phone wraps much past thirty characters and
a wrapped court number reads as a wall. Every active court is listed, booked-out
ones included and marked `full`: the board answers "what is booked", and a court
missing from it would read as a court nobody took. The roster is not on the
board — with `DEFAULT_PLAYERS` seating the same people every time it was the
same handles on every row, and one shared pinned message cannot answer "am I on
this?" per person anyway. Who is playing is named on the court's own panel
behind ⚙️ Manage, which is private.

The board carries a single **🙋 Join** button. A keyboard belongs to the message,
so anything drawn on the pinned board reads the same to everyone — which is why
what you can do lives behind that one button instead, in a list that is private
and can therefore differ per person.

That list holds up to twelve courts: Join for the ones you are not on, Leave for
the ones you are, `🔒 Full` for the rest, and **➕ Add booking**. Each court you
are on is named underneath with who you are playing alongside — the board names
nobody, so this is where you read it, and only for your own courts. Group admins
get **⚙️ Manage bookings** and every roster, since keeping the household
straight is their job. Manage names who is playing and how
many slots are left, edits the date, court, or time, deletes a booking, and lets
admins open extra slots or take a player off. Every active court is listed, the
same as the board. Those two admin actions stay open until the court ends,
which is how a no-show is kept off the tab, while joining and leaving close the
moment it starts, so nobody can play the hour and then drop off the roster to
dodge their share. Taking a slot tells the court privately: the joiner gets a
confirmation, everyone else gets word of it, both naming the roster. These and
the removal notice go to the chat the tap came from, not the one each roster row
was created in — an ephemeral message is only visible where it is posted, and
under `DATA_CHAT_ID` a roster spans groups, so a notice sent by the row would
land in whichever group that member was first seen in. The cost is that somebody
who is only in the other group hears nothing. Reminders still follow the row,
having no tap to take their bearings from.

Every booking seats `DEFAULT_PLAYERS` plus whoever booked it. Players are keyed
on their Telegram username, so someone named in config is the same person who
later taps a button; anyone without a username is keyed on their numeric id.

## Money

| When | Rate |
|---|---|
| From 6pm, weekends, Singapore public holidays | $6/hour |
| Otherwise | $3/hour |

The court is split once it has been played, so a cancelled booking — or a player
an admin takes off before the slot ends — is never billed. The cost is divided by
everyone on the roster, and `OWNER`, `DEFAULT_PLAYERS`, and `UNBILLED_PLAYERS`
are then skipped rather than having their shares spread over the rest, so the
organiser absorbs those shares along with the rounding remainder. With the
example config a $6 evening court seats the organiser, one household player, and
whoever booked it: the booker pays $2.00 and the organiser is left with $4.00.
Because the divisor is the whole roster, taking a no-show off raises what
everyone still on it owes.

A second pinned message lists who owes the organiser. Group admins clear a
balance from it, which appends a payment to the ledger rather than erasing
anything. It unpins itself once everyone is settled.

The 2026 holiday list in `src/pricing.js` should be checked against mom.gov.sg
each December. `PUBLIC_HOLIDAYS` replaces that list rather than adding to it, so
setting it in December 2026 with only 2027 dates un-prices the rest of December
2026 — carry the dates still ahead over with it. Pricing a weekday in a year the
list in force never reaches charges it off-peak and logs a warning that
`npx wrangler tail` shows.

## Privacy

Three things SquashBot sends are addressed to the group: the pinned board, the
pinned tab, and the reminder fallback below. Everything else it sends — forms,
receipts, reminders, errors, and every reply to a command — is ephemeral: only
the recipient and the bot see them.

What you send is a different matter. Commands are registered with
`is_ephemeral`, so a command is never a group message at all — not even for the
moment before a delete. It cannot then be cleared either: a bot may only delete
its own ephemeral messages, so an incoming command stays in the sender's own
chat, seen by nobody else. Booking as ordinary text has the opposite shape: it
is a real group message, delivered and notified before the bot is told it
exists, and can only be deleted afterwards — which needs the **Delete Messages**
admin right, and without it the bot says so privately rather than failing
quietly. Use `/book` for a booking that is never public at any point. The booker
gets a private receipt with an **OK** button either way, so a new booking is
discovered on the board rather than announced.

Each player is reminded two hours before their court and again at 8am on the
day. Reminders and receipts clear themselves at the end of the day they are
about. Telegram does not guarantee ephemeral delivery when the recipient is
offline; if it refuses, the private copy is deleted and the whole roster is
reminded once in the group rather than one public post per player.

## Commands

```text
/book [details]  Add a booking or open a blank form
/courts          Refresh the pinned board
/tab             Refresh the pinned money tab
/cancel ID       Remove a booking you made
/help, /start    Show examples
```

Booking ids are small sequential numbers, so editing or removing one — by command
or from **⚙️ Manage** — is limited to whoever booked the court and to group
admins. A court that has already been played cannot be cancelled at all; it has
to reach the tab.

## Configuration

`wrangler.toml` vars:

| Var | Meaning |
|---|---|
| `ALLOWED_CHATS` | Group ids the bot answers in. Every other chat is ignored |
| `DATA_CHAT_ID` | Optional; one of the above. Makes every listed group share one set of bookings, rosters, history, and one tab. Each group keeps its own pinned messages |
| `OWNER`, `OWNER_NAME` | Who pays the courts. Always an admin, never billed. `OWNER_USER_ID` is read as an alias when `OWNER` is unset |
| `DEFAULT_PLAYERS` | Seated on every new booking, never billed |
| `UNBILLED_PLAYERS` | Never billed, but not seated automatically |
| `DEFAULT_CAPACITY` | Players per court before an admin opens more (default 3) |
| `PUBLIC_HOLIDAYS` | Optional `YYYY-MM-DD` list replacing the built-in one |
| `DEFAULT_TIMEZONE` | Defaults to `Asia/Singapore` |

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

`npm run db:init` runs `schema.sql`, which is entirely `IF NOT EXISTS`: safe on a
live database, and it creates every table and index. What it cannot do is add a
column to a table that already exists, so an existing database also needs the
migrations, or the pinned board and every new booking fail at runtime:

```powershell
npm run db:init
npm run db:migrate:002
npm run db:migrate:003
npm run db:migrate:004
npm run db:verify
```

Run them in that order. Everything the migrations used to create now lives in
`schema.sql`, leaving 002 and 003 as `ALTER TABLE` alone and 004 as a no-op,
because `wrangler d1 execute --file` is atomic: one failed statement rolls the
whole file back, so a `CREATE` sharing a file with an `ALTER` would be skipped on
a re-run rather than applied. That is what makes a re-run harmless — an already
applied migration fails whole with `duplicate column name`, having had nothing
else to lose, and the next file can still be run.

`npm run db:verify` prints `schema_ok` once every migrated column is present, and
otherwise fails naming the one that is missing. It is worth running because that
same atomicity can leave a hand-patched database short: a file whose first
`ALTER` duplicates rolls back the later ones too, and they are never retried.

## Known gaps

Found by review, none of them load-bearing enough to hold a release:

- A username change re-keys a player's roster rows but not their `ledger`
  history, so someone who played before setting a username can appear on the tab
  as two entries. Both are real and both settle; the totals are right.
- `getTimezone` reads a `tz` of `Asia/Singapore` as "never set" so
  `DEFAULT_TIMEZONE` stays reachable. Nothing writes `tz` today, but a future
  per-chat override set to Singapore would be ignored.
- The intent gate accepts a standalone `c` before a number, so `Room C 2 at 8pm`
  opens a booking form — and booking by message deletes the original.
  `c4 tmr 8-9` is the opposite case and is still rejected, because a bare hour
  range does not count as a clock time.
- A receipt or a removal notice that Telegram will not deliver privately is
  deleted rather than posted, so it can end up sent to nobody.
- `DATA_CHAT_ID` is documented as one of `ALLOWED_CHATS`; the code no longer
  requires it, but the public reminder fallback still posts to it, which needs
  the bot to be in that chat.
- A chat dropped from `ALLOWED_CHATS` keeps its rows: they stop being charged and
  its old messages stop being purged.
