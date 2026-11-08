# Known gaps

Found by review, none of them load-bearing enough to hold a release:

- Legacy ledger rows created under username slugs are not rewritten. The private
  breakdown follows their numeric id safely, but the shared tab can show an old
  username and the newer numeric-keyed balance as two entries until both settle.
- `getTimezone` reads a `tz` of `Asia/Singapore` as "never set" so
  `DEFAULT_TIMEZONE` stays reachable. Nothing writes `tz` today, but a future
  per-chat override set to Singapore would be ignored.
- The intent gate takes a bare `c` only when it is attached to its number, so
  `tmr c4 2100` books and `Room C 2 at 8pm` stays conversation — but `c 4 9pm`
  now needs `/book` or the word `court`. `c4 tmr 8-9` is still rejected,
  because a bare hour range does not count as a clock time.
- A receipt or a removal notice that Telegram will not deliver privately is
  deleted rather than posted, so it can end up sent to nobody.
- A board or tab in a chat the bot cannot post to is logged and queued for a
  maintenance retry. A permanently removed chat keeps that retry pending until
  it is removed from `ALLOWED_CHATS` or the bot is re-added.
- A chat dropped from `ALLOWED_CHATS` keeps its rows: they stop being charged and
  its old messages stop being purged.
- A username-only roster row whose owner changes handle before ever posting has
  no numeric identity to reconnect it. Leave now reports that the player was not
  found instead of claiming success; an admin can remove the provisional row.
- An admin taking a player off tells only that player. The rest of the court
  hears about voluntary joins and leaves, but not about the slot a kick frees.
- A reminder Telegram refuses for good — blocked, left the group, no such user —
  counts as sent, because retrying it is one doomed call a minute until the
  court starts. Somebody who unblocks the bot later that day still hears
  nothing about the court they are already on.
- A message the cleanup sweep cannot delete is retried on the next tick, but
  given up on a day past its due time so one wedged row cannot starve the queue behind
  it. That message then stays in the chat for good.
