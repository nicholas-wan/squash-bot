import {
  addBooking, BOOKING_CHANGED, BOOKING_STARTED, BookingConflictError, getTimezone, updateBooking,
} from './bookings.js';
import { courtName } from './format.js';
import { parseBookingCompanions } from './booking-companions.js';
import { isChatAdmin, knownPlayers, openBooking, RosterCapacityError } from './players.js';
import {
  analyzeBooking, bookingFromDraft, BookingParseError, formatClock, parseField,
} from './parser.js';
import { formatDate, formatTime, localParts, zonedEpoch } from './time.js';
import {
  answerCallback, deleteEphemeralMessage, deleteMessage, editEphemeralMessage,
  editMessage, escapeHtml, mentionHtml, sendMessage,
} from './telegram.js';

const DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const BOOKER_ADMIN = 'Only group admins can change who booked a court.';
const MAX_TYPED_BOOKER = 40;

function userName(from) {
  return from && (from.username ? `@${from.username}` : from.first_name) || 'Player';
}

function dateAdd(y, mo, d, days) {
  const value = new Date(Date.UTC(y, mo - 1, d + days));
  return { y: value.getUTCFullYear(), mo: value.getUTCMonth() + 1, d: value.getUTCDate() };
}

function dateLabel(date, tz, short = false) {
  const epoch = zonedEpoch(date.y, date.mo, date.d, 12, 0, tz);
  if (!short) return formatDate(epoch, tz);
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(epoch));
}

function timeLabel(payload) {
  if (!payload.start) return null;
  return payload.end
    ? `${formatClock(payload.start)}–${formatClock(payload.end)}`
    : `${formatClock(payload.start)}–${formatClock({
        h: (payload.start.h + 1) % 24, mi: payload.start.mi,
      })} (1 hour)`;
}

function firstMissing(payload) {
  if (!payload.date) return 'date';
  if (!payload.court) return 'court';
  if (!payload.start) return 'time';
  return null;
}

function defaultDateChoices(now, tz) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date(now)).reduce((out, part) => {
    if (part.type === 'year') out.y = Number(part.value);
    if (part.type === 'month') out.mo = Number(part.value);
    if (part.type === 'day') out.d = Number(part.value);
    return out;
  }, {});
  return Array.from({ length: 7 }, (_, index) => dateAdd(p.y, p.mo, p.d, index));
}

// Courts run 7am to 10pm, so 9pm is the last slot that can be offered. Noon
// and 5pm are there because weekday daytime is the half-price window, and
// reaching it should not cost a "Type another time" round trip.
function defaultTimeChoices() {
  return [7, 8, 12, 17, 18, 19, 20, 21].map((h) => ({
    start: { h, mi: 0 }, end: null, label: formatClock({ h, mi: 0 }),
  }));
}

function prepareChoices(payload, now, tz) {
  const field = firstMissing(payload);
  if (field === 'date' && !payload.dateChoices.length) payload.dateChoices = defaultDateChoices(now, tz);
  if (field === 'court' && !payload.courtChoices.length) {
    // YCK has five courts. When the court is being *changed*, the one the
    // booking already sits on is dropped from the buttons — offering it back
    // would be a button that changes nothing.
    const current = payload.priorCourt
      ? String(payload.priorCourt).trim().toLowerCase() : null;
    payload.courtChoices = ['1', '2', '3', '4', '5']
      .filter((court) => court !== current);
  }
  if (field === 'time' && !payload.timeChoices.length) payload.timeChoices = defaultTimeChoices();
  return field;
}

function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function wizardView(id, payload, now, tz) {
  const field = prepareChoices(payload, now, tz);
  // Booked by: a record-keeping picker, reachable only through the
  // admin-gated button below. A known player is seated and billed as the
  // booker. A typed name is somebody the bot has never seen, so it is a label
  // and nothing more — admin-entered text never seats or bills anyone. Free
  // lives here too, because the usual reason a court costs nobody anything is
  // that whoever booked it paid and is not passing the bill on.
  if (payload.choosingBooker) {
    const rows = [[{
      text: payload.free
        ? '🆓 Free court: ON — tap to bill as usual'
        : '💵 Free court: off — tap to make it free',
      callback_data: `bw:${id}:b:f`,
    }], [{ text: '🙋 Me', callback_data: `bw:${id}:b:me` }]];
    (payload.bookerChoices || []).forEach((player, index) => {
      rows.push([{ text: `👤 ${player.name}`, callback_data: `bw:${id}:b:${index}` }]);
    });
    rows.push([{ text: '✍️ Type a name', callback_data: `bw:${id}:b:t` }]);
    rows.push([{ text: '← Back', callback_data: `bw:${id}:b:k` }]);
    return {
      html: '👤 <b>Who booked this court?</b>\n\n'
        + 'Somebody picked from the list is seated and billed as the booker. '
        + 'A typed name is for somebody the bot does not know yet: it is '
        + 'recorded as the booker, but not seated or billed.\n\n'
        + (payload.free
          ? '🆓 <b>Free court</b>: nobody on it will be billed.'
          : '💵 Billed as usual: the court is split across the roster.'),
      replyMarkup: { inline_keyboard: rows },
      payload,
    };
  }
  const lines = [
    payload.operation === 'edit'
      ? '✏️ <b>Review booking changes</b>'
      : '🎾 <b>Confirm this squash booking</b>',
    '',
    `Date: ${payload.date ? `<b>${escapeHtml(dateLabel(payload.date, tz))}</b>` : '❓ Need your input'}`,
    `Court: ${payload.court ? `<b>Court ${escapeHtml(payload.court)}</b>` : '❓ Need your input'}`,
    `Time: ${payload.start ? `<b>${escapeHtml(timeLabel(payload))}</b>` : '❓ Need your input'}`,
  ];
  if (payload.booker) {
    lines.push(`Booked by: <b>${escapeHtml(payload.booker.name)}</b>${
      payload.booker.typed ? ' (not seated)' : ''}`);
  }
  if (payload.free) lines.push('Cost: <b>🆓 Free</b> — nobody is billed');
  if (payload.companions?.players.length) {
    lines.push(`Also playing: <b>${payload.companions.players.map(p => escapeHtml(p.name)).join(', ')}</b>`);
  }
  if (payload.companions?.plusOne) lines.push('Guest: <b>+1 for you</b>');
  if (payload.sourceText) lines.push('', `From: <code>${escapeHtml(payload.sourceText.slice(0, 180))}</code>`);
  if (payload.issues && payload.issues.length) {
    lines.push('', `⚠️ ${payload.issues.map(escapeHtml).join(' ')}`);
  }
  if (payload.conflicts && payload.conflicts.length) {
    lines.push('', '⚠️ <b>This overlaps an existing booking:</b>');
    for (const conflict of payload.conflicts) {
      const court = courtName(conflict);
      lines.push(
        `• ${escapeHtml(court)} · ${formatDate(conflict.starts_at, tz)} · ` +
        `${formatTime(conflict.starts_at, tz)}–${formatTime(conflict.ends_at, tz)}`
      );
    }
  }

  let keyboard;
  if (field === 'date') {
    lines.push('', '<b>Which date?</b>');
    const buttons = payload.dateChoices.map((date, index) => ({
      text: dateLabel(date, tz, true), callback_data: `bw:${id}:d:${index}`,
    }));
    keyboard = [...chunk(buttons, 2), [
      { text: '✍️ Type another date', callback_data: `bw:${id}:u:d` },
    ]];
  } else if (field === 'court') {
    lines.push('', '<b>Which court?</b>');
    const buttons = payload.courtChoices.map((court, index) => ({
      text: `Court ${court}`, callback_data: `bw:${id}:c:${index}`,
    }));
    keyboard = [...chunk(buttons, 4), [
      { text: '✍️ Type another court', callback_data: `bw:${id}:u:c` },
    ]];
  } else if (field === 'time') {
    lines.push('', '<b>What time?</b>');
    const buttons = payload.timeChoices.map((time, index) => ({
      text: time.label, callback_data: `bw:${id}:t:${index}`,
    }));
    keyboard = [...chunk(buttons, 3), [
      { text: '✍️ Type another time', callback_data: `bw:${id}:u:t` },
    ]];
  } else {
    const editing = payload.operation === 'edit';
    lines.push('', editing
      ? 'Nothing changes until you tap <b>Save changes</b>.'
      : 'Nothing is saved until you tap <b>Add booking</b>.');
    keyboard = [
      [{
        text: payload.conflicts && payload.conflicts.length
          ? (editing ? '⚠️ Save anyway' : '⚠️ Add anyway')
          : (editing ? '✅ Save changes' : '✅ Add booking'),
        callback_data: `bw:${id}:${payload.conflicts && payload.conflicts.length ? 'o' : 'y'}`,
      }],
      [
        { text: '📅 Change date', callback_data: `bw:${id}:x:d` },
        { text: '🔢 Change court', callback_data: `bw:${id}:x:c` },
      ],
      [{ text: '🕐 Change time', callback_data: `bw:${id}:x:t` }],
    ];
    // Attribution and the free flag. Same Admin: label as every gated button.
    if (!editing) {
      const setting = [
        payload.booker && `booked by ${payload.booker.name}`,
        payload.free && (payload.booker ? '🆓 free' : '🆓 free court'),
      ].filter(Boolean).join(' · ');
      keyboard.push([{
        text: setting
          ? `👤 Admin: ${setting} — change`
          : '👤 Admin: booked by / free',
        callback_data: `bw:${id}:x:b`,
      }]);
    }
  }
  keyboard.push([{ text: '✕ Cancel', callback_data: `bw:${id}:n` }]);
  return { html: lines.join('\n'), replyMarkup: { inline_keyboard: keyboard }, payload };
}

async function startWizard(env, msg, text, payload, callbackQueryId, bookingId = null) {
  const now = Date.now();
  const tz = await getTimezone(env, msg.chat.id);
  // A replaced draft used to leave its form behind: the row went, the message
  // stayed, and every tap on it answered "expired" forever. The old form is
  // read before the row is cleared so it can be taken down with it.
  const stale = await env.DB.prepare(
    `SELECT wizard_message_id, wizard_ephemeral FROM booking_drafts
     WHERE chat_id = ? AND user_id = ?`
  ).bind(msg.chat.id, msg.from.id).first();
  const clearDraft = env.DB.prepare(
    'DELETE FROM booking_drafts WHERE chat_id = ? AND user_id = ?'
  ).bind(msg.chat.id, msg.from.id);
  const insertDraft = env.DB.prepare(
    `INSERT INTO booking_drafts
      (chat_id, user_id, user_name, source_text, booking_id, payload,
       source_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    msg.chat.id, msg.from.id, userName(msg.from), String(text), bookingId,
    JSON.stringify(payload), msg.message_id || null, now
  );
  // Order matters, but D1 can run the pair in one round trip. The fallback
  // keeps lightweight test doubles useful without weakening production.
  let inserted;
  if (typeof env.DB.batch === 'function') {
    [, inserted] = await env.DB.batch([clearDraft, insertDraft]);
  } else {
    await clearDraft.run();
    inserted = await insertDraft.run();
  }
  const id = inserted.meta.last_row_id;
  // Best-effort: a form Telegram cannot delete is the state before this fix.
  if (stale && stale.wizard_message_id) {
    if (stale.wizard_ephemeral) {
      await deleteEphemeralMessage(env, msg.chat.id, msg.from.id, stale.wizard_message_id);
    } else {
      await deleteMessage(env, msg.chat.id, stale.wizard_message_id);
    }
  }
  const view = wizardView(id, payload, now, tz);
  const sent = await sendMessage(env, msg.chat.id, view.html, {
    replyMarkup: view.replyMarkup,
    receiverUserId: msg.from.id,
    callbackQueryId,
  });
  if (!sent.ok) {
    await env.DB.prepare('DELETE FROM booking_drafts WHERE id = ?').bind(id).run();
    throw new Error(`Could not start booking wizard: ${sent.description || 'Telegram error'}`);
  }
  const ephemeralId = sent.result.ephemeral_message_id || null;
  const messageId = ephemeralId || sent.result.message_id;
  await env.DB.prepare(
    'UPDATE booking_drafts SET payload = ?, wizard_message_id = ?, wizard_ephemeral = ? WHERE id = ?'
  ).bind(JSON.stringify(view.payload), messageId, ephemeralId ? 1 : 0, id).run();
  // Registered for the end-of-life sweep like every reminder and receipt: a
  // finished form deletes itself, so the sweep only ever finds abandoned ones
  // — which used to linger forever. Deleting an already-gone message is the
  // same outcome, so the double booking is harmless.
  await env.DB.prepare(
    `INSERT INTO sent_messages
      (chat_id, receiver_user_id, message_id, is_ephemeral, delete_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    msg.chat.id, ephemeralId ? msg.from.id : null, messageId,
    ephemeralId ? 1 : 0, now + DRAFT_LIFETIME_MS, now
  ).run();
  return true;
}

async function saveAndRender(env, row, payload, now = Date.now()) {
  const tz = await getTimezone(env, row.chat_id);
  const view = wizardView(row.id, payload, now, tz);
  await env.DB.prepare(
    'UPDATE booking_drafts SET payload = ?, pending_field = NULL, reply_prompt_message_id = NULL WHERE id = ?'
  ).bind(JSON.stringify(view.payload), row.id).run();
  if (row.wizard_ephemeral) {
    await editEphemeralMessage(
      env, row.chat_id, row.user_id, row.wizard_message_id, view.html, view.replyMarkup
    );
  } else {
    await editMessage(env, row.chat_id, row.wizard_message_id, view.html, view.replyMarkup);
  }
}

function applyParsedField(payload, field, parsed) {
  payload.issues = parsed.issue ? [parsed.issue] : [];
  payload.conflicts = [];
  if (field === 'date') {
    payload.date = parsed.value;
    payload.dateChoices = parsed.choices || [];
  } else if (field === 'court') {
    payload.court = parsed.value;
    payload.courtChoices = parsed.choices || [];
  } else {
    payload.start = parsed.value && parsed.value.start;
    payload.end = parsed.value && parsed.value.end;
    payload.timeChoices = parsed.choices || [];
  }
}

export async function beginBooking(env, msg, text, {
  forceIntent = false, callbackQueryId = null,
} = {}) {
  const now = Date.now();
  const tz = await getTimezone(env, msg.chat.id);
  const { details, companions } = parseBookingCompanions(text, msg);
  const payload = analyzeBooking(details, now, tz, { forceIntent });
  if (!payload) return false;
  payload.companions = companions;
  payload.sourceText = text;
  payload.operation = 'add';
  payload.bookingId = null;
  payload.conflicts = [];
  return startWizard(env, msg, text, payload, callbackQueryId);
}

export async function beginEditBooking(env, callback, bookingId, field) {
  const chatId = callback.message.chat.id;
  const booking = await openBooking(env, chatId, bookingId);
  if (!booking) return false;
  const tz = await getTimezone(env, chatId);
  const start = localParts(booking.starts_at, tz);
  const end = localParts(booking.ends_at, tz);
  const payload = {
    operation: 'edit',
    bookingId,
    sourceText: booking.source_text || '',
    editSourceText: '',
    date: { y: start.y, mo: start.mo, d: start.d },
    court: booking.court,
    start: { h: start.h, mi: start.mi },
    end: { h: end.h, mi: end.mi },
    // What the court held when the form opened; the save is refused if it has
    // changed since, rather than putting the other fields back as they were.
    expected: { startsAt: booking.starts_at, endsAt: booking.ends_at, court: String(booking.court) },
    dateChoices: [], courtChoices: [], timeChoices: [], issues: [], conflicts: [],
  };
  if (field === 'date') payload.date = null;
  // The court being edited away is remembered so the picker can leave it out.
  if (field === 'court') { payload.priorCourt = booking.court; payload.court = null; }
  if (field === 'time') { payload.start = null; payload.end = null; }
  return startWizard(env, {
    chat: callback.message.chat,
    from: callback.from,
    message_id: callback.message.message_id,
  }, `Edit booking ${bookingId}`, payload, callback.id, bookingId);
}

async function requestTypedField(env, row, field, callbackId) {
  const labels = {
    date: ['date', '13 Aug, tomorrow, or Friday'],
    court: ['court', '4 or Court A'],
    time: ['time', '9pm or 8pm-9:30pm'],
    booker: ['name of whoever booked it', 'Jared'],
  };
  const [name, example] = labels[field];
  const prompt = await sendMessage(env, row.chat_id,
    `${mentionHtml(row.user_id, row.user_name)}, reply with the ${name}.\nExample: <code>${example}</code>`,
    {
      replyMarkup: {
        force_reply: true,
        input_field_placeholder: field === 'booker' ? 'Type their name' : `Type the ${name}`,
        selective: false,
      },
      receiverUserId: row.user_id,
      callbackQueryId: callbackId,
    }
  );
  if (prompt.ok) {
    const promptId = prompt.result.ephemeral_message_id || prompt.result.message_id;
    await env.DB.prepare(
      'UPDATE booking_drafts SET pending_field = ?, reply_prompt_message_id = ? WHERE id = ?'
    ).bind(field, promptId, row.id).run();
  }
  await answerCallback(env, callbackId, prompt.ok ? '' : 'Could not open the input box.', !prompt.ok);
}

export async function handleBookingCallback(env, callback) {
  const match = String(callback.data || '')
    .match(/^bw:(\d+):([dctuynxob])(?::([dctbfk]|me|\d+))?$/);
  if (!match || !callback.message) return false;
  const id = Number(match[1]);
  const action = match[2];
  const value = match[3];
  const chatId = callback.message.chat.id;
  const row = await env.DB.prepare('SELECT * FROM booking_drafts WHERE id = ? AND chat_id = ?')
    .bind(id, chatId).first();
  if (!row) {
    await answerCallback(env, callback.id, 'This booking form has expired.', true);
    return true;
  }
  if (row.user_id !== callback.from.id) {
    await answerCallback(env, callback.id, 'Only the person who started this booking can use these buttons.', true);
    return true;
  }

  const payload = JSON.parse(row.payload);
  if (action === 'n') {
    await env.DB.prepare('DELETE FROM booking_drafts WHERE id = ? AND user_id = ?')
      .bind(id, callback.from.id).run();
    if (row.wizard_ephemeral) {
      await editEphemeralMessage(
        env, chatId, row.user_id, row.wizard_message_id,
        '✕ <i>Booking cancelled.</i>', { inline_keyboard: [] }
      );
    } else {
      await editMessage(env, chatId, row.wizard_message_id,
        '✕ <i>Booking cancelled.</i>', { inline_keyboard: [] });
    }
    await answerCallback(env, callback.id);
    return true;
  }
  if (action === 'u') {
    const field = { d: 'date', c: 'court', t: 'time' }[value];
    await requestTypedField(env, row, field, callback.id);
    return true;
  }
  if (action === 'x' && value === 'b') {
    // Attribution changes who is seated and billed, so it carries the same
    // gate as seating somebody from the manage panel.
    if (!(await isChatAdmin(env, chatId, callback.from))) {
      await answerCallback(env, callback.id, BOOKER_ADMIN, true);
      return true;
    }
    payload.choosingBooker = true;
    payload.bookerChoices = (await knownPlayers(env, chatId))
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 12)
      .map((player) => ({ slug: player.slug, name: player.name }));
    await saveAndRender(env, row, payload);
    await answerCallback(env, callback.id);
    return true;
  }
  if (action === 'b') {
    if (!(await isChatAdmin(env, chatId, callback.from))) {
      await answerCallback(env, callback.id, BOOKER_ADMIN, true);
      return true;
    }
    // The free toggle stays on the picker: it is usually set together with
    // the booker, and closing the picker would make that two trips.
    if (value === 'f') {
      payload.free = !payload.free;
      await saveAndRender(env, row, payload);
      await answerCallback(env, callback.id,
        payload.free ? 'Free court: nobody is billed' : 'Billed as usual');
      return true;
    }
    if (value === 't') {
      await requestTypedField(env, row, 'booker', callback.id);
      return true;
    }
    if (value === 'k') {
      // Back to the form, with the booker left as it was.
    } else if (value === 'me') {
      payload.booker = null;
    } else {
      const pick = (payload.bookerChoices || [])[Number(value)];
      if (!pick) {
        await answerCallback(env, callback.id, 'That option is no longer available.', true);
        return true;
      }
      // Resolved fresh rather than trusted from the button, so a stale form
      // cannot record somebody under an outdated name or id.
      const player = (await knownPlayers(env, chatId))
        .find((candidate) => candidate.slug === pick.slug);
      if (!player) {
        await answerCallback(env, callback.id, 'That player is no longer known.', true);
        return true;
      }
      payload.booker = { userId: player.user_id || null, slug: player.slug, name: player.name };
    }
    payload.choosingBooker = false;
    payload.bookerChoices = [];
    await saveAndRender(env, row, payload);
    await answerCallback(env, callback.id);
    return true;
  }
  if (action === 'x') {
    if (value === 'd') { payload.date = null; payload.dateChoices = []; }
    if (value === 'c') {
      // Same rule as the manage flow: the court being moved away from is not
      // offered back. Falls back to any earlier remembered court, so tapping
      // Change court twice keeps excluding the right one.
      payload.priorCourt = payload.court || payload.priorCourt || null;
      payload.court = null; payload.courtChoices = [];
    }
    if (value === 't') { payload.start = null; payload.end = null; payload.timeChoices = []; }
    payload.issues = []; payload.conflicts = [];
    await saveAndRender(env, row, payload);
    await answerCallback(env, callback.id);
    return true;
  }
  if (action === 'd' || action === 'c' || action === 't') {
    const index = Number(value);
    if (action === 'd' && payload.dateChoices[index]) {
      payload.date = payload.dateChoices[index]; payload.dateChoices = [];
    } else if (action === 'c' && payload.courtChoices[index]) {
      payload.court = payload.courtChoices[index]; payload.courtChoices = [];
    } else if (action === 't' && payload.timeChoices[index]) {
      payload.start = payload.timeChoices[index].start;
      payload.end = payload.timeChoices[index].end;
      payload.timeChoices = [];
    } else {
      await answerCallback(env, callback.id, 'That option is no longer available.', true);
      return true;
    }
    payload.issues = []; payload.conflicts = [];
    await saveAndRender(env, row, payload);
    await answerCallback(env, callback.id);
    return true;
  }
  if (action === 'y' || action === 'o') {
    const tz = await getTimezone(env, chatId);
    let booking;
    try {
      booking = bookingFromDraft(payload, Date.now(), tz);
    } catch (error) {
      const message = error instanceof BookingParseError ? error.message : 'Please check the booking details.';
      payload.issues = [message];
      await saveAndRender(env, row, payload);
      await answerCallback(env, callback.id, message, true);
      return true;
    }
    const claim = await env.DB.prepare(
      `UPDATE booking_drafts SET pending_field = '__saving__'
       WHERE id = ? AND user_id = ? AND (pending_field IS NULL OR pending_field != '__saving__')`
    ).bind(id, callback.from.id).run();
    if (!claim.meta.changes) {
      await answerCallback(env, callback.id, 'This booking was already handled.', true);
      return true;
    }
    let saved;
    try {
      if (payload.operation === 'edit') {
        saved = await updateBooking(
          env, chatId, payload.bookingId, booking, callback.from,
          payload.editSourceText || 'Edited with SquashBot',
          { allowConflict: action === 'o', expected: payload.expected || null }
        );
      } else {
        saved = await addBooking(
          env, chatId, booking, callback.from, payload.sourceText || null,
          // Telegram needs the tap to deliver a private message to someone it
          // has no other recent contact with.
          {
            allowConflict: action === 'o', callbackQueryId: callback.id,
            bookedFor: payload.booker || null,
            free: Boolean(payload.free),
            companions: payload.companions,
          }
        );
      }
    } catch (error) {
      if (error instanceof BookingConflictError) {
        payload.conflicts = error.conflicts;
        payload.issues = [];
        await saveAndRender(env, row, payload);
        await answerCallback(env, callback.id, 'This overlaps another booking. Confirm again to continue.', true);
        return true;
      }
      await env.DB.prepare('UPDATE booking_drafts SET pending_field = NULL WHERE id = ?')
        .bind(id).run();
      if (error instanceof RosterCapacityError) {
        await answerCallback(env, callback.id, error.message, true);
        return true;
      }
      throw error;
    }
    await env.DB.prepare('DELETE FROM booking_drafts WHERE id = ? AND user_id = ?')
      .bind(id, callback.from.id).run();
    // The court came into play while this form was open: updateBooking says so
    // rather than saving, because the charge is written when the booking
    // expires and moving it off tonight would take the bill with it.
    if (saved === 'started') {
      await answerCallback(env, callback.id, BOOKING_STARTED, true);
      return true;
    }
    if (saved === 'played') {
      await answerCallback(env, callback.id,
        'That court has already finished, so it can no longer be edited.', true);
      return true;
    }
    // The draft is already gone, so the stale form goes with it.
    if (saved === 'changed') {
      if (row.wizard_ephemeral) {
        await deleteEphemeralMessage(env, chatId, row.user_id, row.wizard_message_id);
      } else {
        await deleteMessage(env, chatId, row.wizard_message_id);
      }
      await answerCallback(env, callback.id, BOOKING_CHANGED, true);
      return true;
    }
    if (!saved) {
      await answerCallback(env, callback.id, 'That booking no longer exists.', true);
      return true;
    }
    // The form has done its job: the tap confirmation says it worked and the
    // pinned board carries the result, so the form itself goes away.
    const editing = payload.operation === 'edit';
    if (row.wizard_ephemeral) {
      await deleteEphemeralMessage(env, chatId, row.user_id, row.wizard_message_id);
    } else {
      await deleteMessage(env, chatId, row.wizard_message_id);
    }
    await answerCallback(env, callback.id,
      editing ? '✅ Booking updated' : '✅ Booking added');
    return true;
  }
  return false;
}

// Takes down the reply prompt and, outside ephemeral mode, the typed answer.
async function clearReplyPrompt(env, row, msg, replyId) {
  if (row.wizard_ephemeral) {
    await deleteEphemeralMessage(env, msg.chat.id, msg.from.id, replyId);
  } else {
    await deleteMessage(env, msg.chat.id, replyId);
    if (msg.message_id) await deleteMessage(env, msg.chat.id, msg.message_id);
  }
}

// A typed booker. A name or handle the bot already knows is the same as
// picking it from the list, so that person is seated and billed as usual.
// Anything else is somebody the bot has never seen: it is kept as a label on
// the booking and nothing more, since admin-entered text must never mint a
// ledger account. A word two known players answer to is not guessed at.
async function applyTypedBooker(env, row, payload, msg, replyId) {
  if (!(await isChatAdmin(env, msg.chat.id, msg.from))) return true;
  const name = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TYPED_BOOKER);
  if (name) {
    const wanted = name.toLowerCase();
    const handle = `@${wanted.replace(/^@/, '')}`;
    const matches = (await knownPlayers(env, msg.chat.id)).filter((player) =>
      player.slug === wanted || player.slug === handle
      || player.name.toLowerCase() === wanted);
    if (matches.length === 1) {
      const [player] = matches;
      payload.booker = { userId: player.user_id || null, slug: player.slug, name: player.name };
    } else {
      payload.booker = { userId: null, slug: null, name, typed: true };
    }
    payload.choosingBooker = false;
    payload.bookerChoices = [];
  }
  await saveAndRender(env, row, payload);
  await clearReplyPrompt(env, row, msg, replyId);
  return true;
}

export async function handleBookingReply(env, msg) {
  const replyId = msg.reply_to_message
    && (msg.reply_to_message.ephemeral_message_id || msg.reply_to_message.message_id);
  if (!replyId || !msg.from) return false;
  const row = await env.DB.prepare(
    `SELECT * FROM booking_drafts
     WHERE chat_id = ? AND user_id = ? AND reply_prompt_message_id = ? AND created_at > ?`
  ).bind(msg.chat.id, msg.from.id, replyId, Date.now() - DRAFT_LIFETIME_MS).first();
  if (!row || !row.pending_field) return false;

  const payload = JSON.parse(row.payload);
  if (row.pending_field === 'booker') return applyTypedBooker(env, row, payload, msg, replyId);
  const tz = await getTimezone(env, msg.chat.id);
  const parsed = parseField(row.pending_field, msg.text, Date.now(), tz);
  applyParsedField(payload, row.pending_field, parsed);
  if (payload.operation === 'edit') {
    payload.editSourceText = [payload.editSourceText, `${row.pending_field}: ${msg.text}`]
      .filter(Boolean).join('; ');
  }
  if (!parsed.value && !(parsed.choices && parsed.choices.length)) {
    const field = row.pending_field;
    const prompt = await sendMessage(env, msg.chat.id,
      `⚠️ ${escapeHtml(parsed.issue || `I couldn't read that ${field}.`)} Please reply again.`,
      {
        replyMarkup: {
          force_reply: true,
          input_field_placeholder: `Type the ${field}`,
          selective: false,
        },
        receiverUserId: msg.from.id,
        replyToEphemeral: msg.ephemeral_message_id || null,
      }
    );
    if (prompt.ok) {
      const promptId = prompt.result.ephemeral_message_id || prompt.result.message_id;
      await env.DB.prepare('UPDATE booking_drafts SET reply_prompt_message_id = ? WHERE id = ?')
        .bind(promptId, row.id).run();
    }
    return true;
  }

  await saveAndRender(env, row, payload);
  await clearReplyPrompt(env, row, msg, replyId);
  return true;
}

export async function pruneBookingDrafts(env, now = Date.now()) {
  await env.DB.prepare('DELETE FROM booking_drafts WHERE created_at < ?')
    .bind(now - DRAFT_LIFETIME_MS).run();
}
