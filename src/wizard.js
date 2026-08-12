import { addBooking, getTimezone } from './bookings.js';
import {
  analyzeBooking, bookingFromDraft, BookingParseError, draftComplete, formatClock, parseField,
} from './parser.js';
import { formatDate, zonedEpoch } from './time.js';
import {
  answerCallback, deleteEphemeralMessage, deleteMessage, editEphemeralMessage,
  editMessage, escapeHtml, mentionHtml, sendMessage,
} from './telegram.js';

const DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000;

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

function defaultTimeChoices() {
  return [17, 18, 19, 20, 21, 22].map((h) => ({
    start: { h, mi: 0 }, end: null, label: formatClock({ h, mi: 0 }),
  }));
}

function prepareChoices(payload, now, tz) {
  const field = firstMissing(payload);
  if (field === 'date' && !payload.dateChoices.length) payload.dateChoices = defaultDateChoices(now, tz);
  if (field === 'court' && !payload.courtChoices.length) {
    payload.courtChoices = ['1', '2', '3', '4', '5', '6', '7', '8'];
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
  const lines = [
    '🎾 <b>Check this squash booking</b>',
    '',
    `Date: ${payload.date ? `<b>${escapeHtml(dateLabel(payload.date, tz))}</b>` : '❓ Need your input'}`,
    `Court: ${payload.court ? `<b>Court ${escapeHtml(payload.court)}</b>` : '❓ Need your input'}`,
    `Time: ${payload.start ? `<b>${escapeHtml(timeLabel(payload))}</b>` : '❓ Need your input'}`,
  ];
  if (payload.sourceText) lines.push('', `From: <code>${escapeHtml(payload.sourceText.slice(0, 180))}</code>`);
  if (payload.issues && payload.issues.length) {
    lines.push('', `⚠️ ${payload.issues.map(escapeHtml).join(' ')}`);
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
    lines.push('', 'Nothing is saved until you tap <b>Add booking</b>.');
    keyboard = [
      [{ text: '✅ Add booking', callback_data: `bw:${id}:y` }],
      [
        { text: '📅 Change date', callback_data: `bw:${id}:x:d` },
        { text: '🔢 Change court', callback_data: `bw:${id}:x:c` },
      ],
      [{ text: '🕐 Change time', callback_data: `bw:${id}:x:t` }],
    ];
  }
  keyboard.push([{ text: '✕ Cancel', callback_data: `bw:${id}:n` }]);
  return { html: lines.join('\n'), replyMarkup: { inline_keyboard: keyboard }, payload };
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
  const payload = analyzeBooking(text, now, tz, { forceIntent });
  if (!payload) return false;

  if (draftComplete(payload)) {
    const booking = bookingFromDraft(payload, now, tz);
    const id = await addBooking(env, msg.chat.id, booking, msg.from, text);
    await sendMessage(env, msg.chat.id,
      `✅ Added court booking <b>#${id}</b>. The pinned court board is up to date.`,
      {
        silent: true,
        receiverUserId: msg.from.id,
        callbackQueryId,
      }
    );
    return true;
  }

  // One active wizard per requester per chat. A new booking supersedes an
  // abandoned one, without affecting anyone else's wizard.
  await env.DB.prepare('DELETE FROM booking_drafts WHERE chat_id = ? AND user_id = ?')
    .bind(msg.chat.id, msg.from.id).run();
  const inserted = await env.DB.prepare(
    `INSERT INTO booking_drafts
      (chat_id, user_id, user_name, source_text, payload, source_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    msg.chat.id, msg.from.id, userName(msg.from), String(text), JSON.stringify(payload),
    msg.message_id || null, now
  ).run();
  const id = inserted.meta.last_row_id;
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
  return true;
}

async function requestTypedField(env, row, field, callbackId) {
  const labels = {
    date: ['date', '13 Aug, tomorrow, or Friday'],
    court: ['court', '4 or Court A'],
    time: ['time', '9pm or 9pm-10:30pm'],
  };
  const [name, example] = labels[field];
  const prompt = await sendMessage(env, row.chat_id,
    `${mentionHtml(row.user_id, row.user_name)}, reply with the ${name}.\nExample: <code>${example}</code>`,
    {
      replyMarkup: {
        force_reply: true,
        input_field_placeholder: `Type the ${name}`,
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
  const match = String(callback.data || '').match(/^bw:(\d+):([dctuynx])(?::([dct]|\d+))?$/);
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
  if (action === 'x') {
    if (value === 'd') { payload.date = null; payload.dateChoices = []; }
    if (value === 'c') { payload.court = null; payload.courtChoices = []; }
    if (value === 't') { payload.start = null; payload.end = null; payload.timeChoices = []; }
    payload.issues = [];
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
    payload.issues = [];
    await saveAndRender(env, row, payload);
    await answerCallback(env, callback.id);
    return true;
  }
  if (action === 'y') {
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
    const claim = await env.DB.prepare('DELETE FROM booking_drafts WHERE id = ? AND user_id = ?')
      .bind(id, callback.from.id).run();
    if (!claim.meta.changes) {
      await answerCallback(env, callback.id, 'This booking was already handled.', true);
      return true;
    }
    const bookingId = await addBooking(
      env, chatId, booking, callback.from, payload.sourceText || null
    );
    const confirmation = `✅ Added court booking <b>#${bookingId}</b>. The pinned court board is up to date.`;
    if (row.wizard_ephemeral) {
      await editEphemeralMessage(
        env, chatId, row.user_id, row.wizard_message_id,
        confirmation, { inline_keyboard: [] }
      );
    } else {
      await editMessage(env, chatId, row.wizard_message_id, confirmation, { inline_keyboard: [] });
    }
    await answerCallback(env, callback.id, 'Booking added');
    return true;
  }
  return false;
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
  const tz = await getTimezone(env, msg.chat.id);
  const parsed = parseField(row.pending_field, msg.text, Date.now(), tz);
  applyParsedField(payload, row.pending_field, parsed);
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
  if (row.wizard_ephemeral) {
    await deleteEphemeralMessage(env, msg.chat.id, msg.from.id, replyId);
  } else {
    await deleteMessage(env, msg.chat.id, replyId);
    if (msg.message_id) await deleteMessage(env, msg.chat.id, msg.message_id);
  }
  return true;
}

export async function pruneBookingDrafts(env, now = Date.now()) {
  await env.DB.prepare('DELETE FROM booking_drafts WHERE created_at < ?')
    .bind(now - DRAFT_LIFETIME_MS).run();
}
