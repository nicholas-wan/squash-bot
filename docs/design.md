# Design notes

How SquashBot behaves and why. The [README](../README.md) covers what the bot
does and how to run it; this file keeps the reasoning behind the behaviour, so
a change that looks like a simplification can be checked against the reason it
was not done that way. Operations live in [operations.md](operations.md) and
known limitations in [known-gaps.md](known-gaps.md).

- [Bookings](#bookings)
- [The board](#the-board)
- [Money](#money)
- [Privacy](#privacy)
- [Commands](#commands)

## Bookings

Group admins can type a booking as an ordinary group message; everybody else
puts the same words after `/book` (see [Privacy](#privacy) for why):

```text
13 Aug Court 4 9pm
court four tomorrow at 9pm
Friday 8pm-9:30pm, Court 2
tmr c4 2100
fri c2 7:30-8:30pm
```

A clock may skip its colon with am or pm (`830pm`), and the minutes in a range
such as `7:30-8:30pm` are never read as a day and month.

Anything missing or ambiguous is asked with buttons rather than guessed, and
nothing is saved until it is confirmed. No end time means one hour. Courts run
**7am to 10pm**, so 9pm is the last slot. YCK has five courts, so the picker
offers Courts 1–5 — and when a court is being *changed*, only the four the
booking is not already on. Overlaps on the same court are blocked
unless the requester reviews the conflict and chooses **Add anyway**. Every add,
edit, and delete keeps an audit snapshot with the actor and the original text.

## The board

Each group sharing the board also carries one **Next available court** message:
a silent post (Telegram's native `disable_notification: true`, a notification
without sound) for the earliest upcoming court with a free slot, with a
**🙋 Join** button that joins that court, the roster as it stands, and an admin row — **➕ Admin: add**
and **➖ Admin: remove** — opening that court's seat and remove pickers
directly. The keyboard is shared, so members see the row too; the routes
behind it refuse them with a toast. There is only ever one, so the bot's
latest message is always the most upcoming open court. Joins, +1s, and edits to
that court's time or court number change the message in place. When a different
court becomes the one to point at — a nearer court is booked, the current one
fills, starts, or is cancelled — the old message is deleted and a fresh one is
posted at the bottom of the chat; when no open court remains, it is deleted
and nothing replaces it. The pinned board and tab are drawn before it, and
should either have to be posted afresh — the first booking after an empty
spell, say — the message sees it is no longer last and moves back below them.
The "SquashBot pinned …" notice Telegram adds for each of the bot's own pins
is deleted as it arrives; pins made by people are left alone. A message Telegram refuses to delete — one older than
48 hours in a group where the bot lacks the Delete Messages right — is kept and
rewritten in place for the next court instead, or, when no court is open,
rewritten to say "No courts available", with no button, rather than naming
the court it last announced. The chat therefore never collects a trail of
retired announcements, and the bot never posts a line that only points at the
board. A batch of new bookings therefore produces one message
for the nearest of them, not one each, and a court further out is never
announced until it is next. Maintenance posts the message if a refresh failed
and moves it on at the start time. Telegram only permits deletion within 48
hours of sending: if it refuses an older message, the bot rewrites it to say no
courts are available and removes its Join button instead.

```text
in 5 days · Mon 17 Aug
9pm · Court 4 · 1 slot · 2/3
```

Two short lines and a gap, because a phone wraps much past thirty characters and
a wrapped court number reads as a wall. Every active court is listed, booked-out
ones included and marked `full`: the board answers "what is booked", and a court
missing from it would read as a court nobody took. An open court carries its
head count too — `1 slot · 2/3` is one seat free, two of three taken. An open
court's roster is not on the board — with `DEFAULT_PLAYERS` seating the same
people every time it was the same handles on every row, and one shared pinned
message cannot answer "am I on this?" per person anyway. Two exceptions. A
full court: nobody can join it, so the board names who took it on a line
underneath. And the nearest court — every court sharing the earliest start —
because that is the one people are deciding about tonight, and "who is on it"
is the question they open the board to ask. For any other open court, who is
playing is named on the court's own panel behind ⚙️ Manage, which is private.
A court booked by somebody other than the organiser carries `📝 Booked by`
and their name underneath; the organiser books most courts, and naming them
on every row would bury the one row that is news. A court that has started
reads `playing now` instead of its slots, since its roster is locked: the
sweep the scheduler runs at each start redraws the board for it.

The board carries a single **🙋 Join** button. A keyboard belongs to the message,
so anything drawn on the pinned board reads the same to everyone — which is why
what you can do lives behind that one button instead, in a list that is private
and can therefore differ per person.

That list holds up to twelve courts: Join for the ones you are not on, Leave for
the ones you are, `🔒 Full` for the rest, and **➕ Add booking**. Each court you
are on is named underneath with who you are playing alongside — the board only
names the players on full courts and the nearest one, so this is where you
read it for the rest, and only for your own courts. Group admins
get **⚙️ Manage bookings** and every roster, since keeping the household
straight is their job. They also get **➕ Seat someone** for the next court
with a free slot — the one the availability message points at — which opens
that court's seat picker directly: Join, the row, the name, three taps where
going through Manage, the court, and "add a player" was five. Any other court
is still seated through Manage. Manage names who is playing and how
many slots are left, edits the date, court, or time, deletes a booking, and lets
admins open extra slots, seat a player the bot already knows — billed as if
they joined themselves, or with a friend who costs them a second slot and a
second share, and refused when the court has no room — flip a +1 on or off
somebody already seated under the same capacity rule, or take a player off.
The seat picker also carries **🎁 Nicholas +1 — free guest** (named from
`OWNER_NAME`): a +1 on the organiser, whose shares never reach the tab, so
the guest is charged to nobody — the organiser absorbs it. It seats the
organiser too if they had been taken off, and the same row turns it off.
Every active court is listed, the
same as the board. Those two admin actions stay open until the court ends,
which is how a no-show is kept off the tab, while joining and leaving close the
moment it starts, so nobody can play the hour and then drop off the roster to
dodge their share. Taking a slot or giving one up tells the court privately: whoever
tapped gets a confirmation, everyone else on the court gets word of it, both
naming the roster as it stands after the tap — so a freed slot is news rather
than something noticed later on the board. A cancelled or moved booking is
announced to its roster the same private way — a reminder may already be in
hand, and silence there is how no-shows happen. These and
the removal notice go to the chat the tap came from, not the one each roster row
was created in — an ephemeral message is only visible where it is posted, and
under `DATA_CHAT_ID` a roster spans groups, so a notice sent by the row would
land in whichever group that member was first seen in. The cost is that somebody
who is only in the other group hears nothing. Reminders still follow the row,
having no tap to take their bearings from.

Every booking seats `DEFAULT_PLAYERS` plus whoever booked it. A numeric Telegram
id is authoritative once it is known: a later holder of the same username cannot
inherit that player's roster or private tab. Username-only config entries remain
provisional until that person first posts, so use `id:Name` entries for every
seeded or unbilled player when identity reuse must be prevented. New ledger charges use numeric identities;
usernames are display names rather than ownership proof.
A group admin can record somebody else as the booker from the confirm form's
**👤 Admin: booked by / free** button. Somebody picked from the list is seated
and billed as the booker and may cancel the court, while the audit row still
names the admin. **✍️ Type a name** covers somebody the bot has never seen: a
name or handle it already knows is treated as picking that person, and
anything else is recorded as the booker's name only — not seated, not billed,
and only admins can cancel — because admin-entered text never mints a ledger
account. The board names the booker under the court — unless it was the
organiser — and the admin panel always does.

The same picker carries a **Free court** toggle, for a court whoever booked it
paid for and is not charging anyone. A free court is never billed: nobody on
its roster reaches the tab, and the admin panel marks it 🆓.

## Money

Known accounts always use `u<Telegram ID>` as their ledger key, enforced by
database triggers as well as the charging code. Usernames are permanent aliases,
not account keys: an authenticated Telegram sender can link provisional history
on first contact, and renaming does not split their balance. An alias already
owned by another ID is never reassigned. Display names do not link accounts.
Legacy aliases associated with multiple IDs are reserved for manual review.
Balances, settlements, private breakdowns, monthly notices and hand-written
`/debt` entries use the same canonical rows, preserving every original charge
and payment.

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
everyone still on it owes. The divisor counts heads rather than names: a player
an admin seated with a friend holds two of the court's slots and pays both
shares in one charge, the friend having nobody to bill but them.

A second pinned message lists who owes the organiser. Group admins clear a
balance from it, which appends a payment to the ledger rather than erasing
anything. It unpins itself once everyone is settled — `/tab` then answers with
your own private breakdown instead, so history stays readable between rounds.
Its 🧾 **My tab** button
sends anyone their own private breakdown — every charge and payment since
they last settled, and never less than the last two weeks, so settling up
does not erase the recent record of who played what. Older settled history
is counted rather than replayed, because an append-only ledger rendered
whole would outgrow a Telegram message within a year. Rows tied to an account are
matched by numeric id, so history under an old handle is still owned without
exposing it to a new holder of that handle. Group admins additionally get a row per open balance
under their own breakdown, each opening that person's tab, since collecting
is their job; members can never see anyone else's. Clearing a balance sends
the debtor a private receipt. Once a month — the first cron tick past 9am
local — everyone owing `TAB_NOTICE_MIN` or more (default $20) is queued for
their itemised balance, and each one is delivered the same private way the
next time that person posts or taps anything in the group. Nothing is sent
on the 1st itself: an ephemeral message fired blind only reaches somebody who
happens to be online at that minute, and Telegram says as much, whereas a
person who has just posted is certainly there. Somebody still not seen by
`TAB_NOTICE_FALLBACK_DAY` (default the 7th) is sent it blind after all, from
9am that day, into the chat they were last seated from — a copy that might
land beats one that never goes. Sending it closes the row: Telegram reports
success either way, so a later sighting cannot tell a dropped copy from a
read one, and a second copy would nag everyone who read the first. The bot
does the asking rather than a person, the ask arrives with its reasons, and
it comes once a month at most: one queued row per debtor per month, a newer
month superseding an older one still waiting. The amount is read at
delivery, so a balance settled or brought under the threshold in the meantime
is not asked for. Smaller balances are left to the pinned tab. A debtor the
ledger knows only by handle has no numeric id to send to, so for them the
sighting path is the only one until they post.

The 2026 holiday list in `src/pricing.js` should be checked against mom.gov.sg
each December. `PUBLIC_HOLIDAYS` replaces that list rather than adding to it, so
setting it in December 2026 with only 2027 dates un-prices the rest of December
2026 — carry the dates still ahead over with it. Pricing a weekday in a year the
list in force never reaches charges it off-peak and logs a warning that
`npx wrangler tail` shows.

## Privacy

The pinned board, pinned tab, availability announcements, and reminder fallback
below are addressed to the group. Everything else it sends — forms,
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
quietly. That delete is why free text is only read as a booking from group
admins: the intent gate is loose on purpose, and applied to everyone it cleared
ordinary chat out of the group for looking like a court. Anybody else's
booking-shaped message is ignored where it stands — no form, nothing removed —
so members book with `/book`, which is never public at any point. Whether a
message reads as a booking is decided once, on the text with its @handles and
`+1` taken out, so the delete and the form never disagree: an admin's "+1 for
squash" stays where it is. A booking form Telegram would only deliver as a
group message is deleted, and the booker is asked to try again. The booker
gets a private receipt with **OK** and **🗑 Cancel booking** either way — the
receipt is the one message every booker has, so it is where they cancel from;
cancelling asks to confirm first. The separate availability
announcement shows the court, time, free slots and who is on it already, so
"should I join" is answerable from the message; it does not name the booker.

Each player is reminded two hours before their court and again at 10am on the
day. Reminders and receipts clear themselves at the end of the day they are
about. Panels — the court list, Manage, a 🧾 tab breakdown — are working
surfaces rather than records, so each clears itself a day after it opens.
Telegram does not guarantee ephemeral delivery when the recipient is
offline; if it refuses, the private copy is deleted and the whole roster is
reminded once in the group rather than one public post per player. Refusal is
the detectable case only: Telegram can also accept an ephemeral send — id
returned, success reported — and still drop it for an offline recipient,
which is documented Bot API behaviour and was confirmed live. A tap's
`callback_query_id` grants reliable delivery, which is why every panel and
receipt arrives; a cron reminder has no tap to ride on, so it only reliably
reaches players who are online when it fires. The fix would be reminders as
ordinary DMs — stored and pushed, needing each player to Start the bot once —
considered and declined to keep the bot group-only.

## Commands

```text
/book [details] [@player or +1]  Add a booking; tag a player or bring a guest
/courts          Refresh the pinned board
/tab             Refresh the pinned money tab
/debt +2 player reason   Admins: add to or take off what someone owes
/debt undo               Admins: remove a /debt entry made by mistake
/cancel ID       Remove a booking you made
/help, /start    Show examples
```

`/debt` writes the one entry the courts cannot produce for themselves — a ball
somebody replaced, cash handed over outside the tab, half an hour of a court
somebody missed. A plus adds to what they owe and a minus takes it off, matching
the direction the ledger already counts in, and the reason is required because
it is the whole entry: everything else on a tab is calculated and can be
re-derived, while this line can only ever explain itself. It is written as an
ordinary ledger row, so it appears in that person's own 🧾 breakdown beside the
courts they played, carrying the reason, the name of whoever typed it, and its
date. They are sent a private note with the same reason, exactly as a settlement
sends its receipt — which needs their numeric id, so a config-seeded player
hears nothing until they have posted once. A note Telegram can only deliver to
the group is taken down rather than left there, and either way the admin's
confirmation says whether the player was told, so nobody finds a charge on
their tab that nobody mentioned.

Nothing is written until the admin who typed it confirms. `+5` and `-5` are one
keystroke apart and mean opposite things, so `/debt` first answers privately
with what the entry means in words — "Jared owes you $5" or "You owe Jared $5"
(the organiser's name in place of "you" when another admin typed it) — with
the reason, the balance now and the balance after. **✅ Confirm** writes it and
sends the receipt; **✖️ Cancel** drops it. The pending entry waits in
`debt_drafts`, since the reason is too long for a button, and only the admin
who drafted it can confirm it.

```text
/debt +2 jared mcdonalds ice cream
/debt -1 jared played only 30 mins last time
```

Admins only, like every other route that moves money. The player may be named by
first name, display name, `@handle`, or numeric id, but only somebody the bot
already knows — from config, from the ledger, or from a current roster — can be
charged: admin-entered free text must never mint a ledger account, the same rule
that keeps a display name from claiming financial history. A word two people
answer to is refused rather than guessed at, since guessing bills the wrong
person and nothing downstream can tell. The organiser and the household play
for free and are refused outright: a row for them would list the organiser as
owing themselves. An update Telegram delivers twice is handled once, so a
redelivered `/debt` is not a second entry.

A `/debt` typed by mistake is undone rather than corrected with its opposite:
a charge and a refund that cancel out are two lines the player has to puzzle
over. The confirmation carries an **↩️ Undo** button, and `/debt undo` lists the
last few `/debt` entries for when that confirmation is already gone. Undo
deletes the row, so the tab reads as though it was never written, and the
player is told it was removed. It reaches only rows `/debt` wrote, and only for
7 days: court charges and settlements are money that really moved, and the rest
of the ledger stays append-only.

Booking ids are small sequential numbers, so editing or removing one — by command,
from the receipt, or from **⚙️ Manage** — is limited to whoever booked the court and to group
admins. Once the court starts, only a group admin can change or cancel it: the
tab is charged when the booking expires, so a cancellation during the hour of
play — or a move to tomorrow and a cancellation there — would erase everyone's
share of a court that was played. A court that has already been played cannot be
edited or cancelled at all, by anybody; it has to reach the tab.
