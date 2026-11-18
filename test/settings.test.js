import { afterEach, describe, expect, it, vi } from 'vitest';
import { updatePinnedMessage } from '../src/settings.js';

// A settings row with a board already pinned, and a record of every write, so a
// test can assert that a failed edit did not quietly re-point the column at a
// second message.
function settingsDb(row = { board_message_id: 55, tab_message_id: null }) {
  const runs = [];
  return {
    runs,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              return sql.includes('board_message_id') ? row : null;
            },
            async run() {
              runs.push({ sql, args });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

// Answers every Telegram call with { ok: true }, except editMessageText, which
// answers with whatever this particular test is about, and any method named in
// `others`.
function captureTelegram(editResponse = { ok: true, result: { message_id: 55 } }, others = {}) {
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const href = String(url);
    requests.push({ url: href, body: JSON.parse(init.body) });
    const method = href.split('/').pop();
    const body = method === 'editMessageText' ? editResponse
      : others[method] || { ok: true, result: { message_id: 77 } };
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  }));
  return requests;
}

const methodsOf = (requests) => requests.map((request) => request.url.split('/').pop());

describe('updatePinnedMessage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('edits the pinned board in place and keeps its id', async () => {
    const requests = captureTelegram();
    const db = settingsDb();
    const id = await updatePinnedMessage(
      { BOT_TOKEN: 'test', DB: db }, -123, 'board_message_id', '<b>board</b>', null, 'court board'
    );
    expect(id).toBe(55);
    expect(methodsOf(requests)).toEqual(['editMessageText']);
    expect(db.runs).toHaveLength(0);
  });

  it('treats an unchanged board as up to date', async () => {
    const requests = captureTelegram({
      ok: false, description: 'Bad Request: message is not modified',
    });
    const db = settingsDb();
    const id = await updatePinnedMessage(
      { BOT_TOKEN: 'test', DB: db }, -123, 'board_message_id', '<b>board</b>', null, 'court board'
    );
    expect(id).toBe(55);
    expect(methodsOf(requests)).toEqual(['editMessageText']);
    expect(db.runs).toHaveLength(0);
  });

  it('sends and pins a replacement when the old board is really gone', async () => {
    const requests = captureTelegram({
      ok: false, description: 'Bad Request: message to edit not found',
    });
    const db = settingsDb();
    const id = await updatePinnedMessage(
      { BOT_TOKEN: 'test', DB: db }, -123, 'board_message_id', '<b>board</b>', null, 'court board'
    );
    expect(id).toBe(77);
    expect(methodsOf(requests))
      .toEqual(['editMessageText', 'unpinChatMessage', 'sendMessage', 'pinChatMessage']);
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].sql).toContain('INSERT INTO settings');
    expect(db.runs[0].args).toEqual([-123, 77]);
  });

  it('throws rather than pinning a second board when Telegram is rate limiting', async () => {
    const requests = captureTelegram({
      ok: false, description: 'Too Many Requests: retry after 5',
    });
    const db = settingsDb();
    await expect(updatePinnedMessage(
      { BOT_TOKEN: 'test', DB: db }, -123, 'board_message_id', '<b>board</b>', null, 'court board'
    )).rejects.toThrow(/court board.*retry after 5/);
    expect(methodsOf(requests)).toEqual(['editMessageText']);
    expect(db.runs).toHaveLength(0);
  });

  it('throws rather than pinning a second board when the edit times out', async () => {
    const requests = captureTelegram({
      ok: false,
      description: 'TimeoutError: The operation was aborted due to timeout',
    });
    const db = settingsDb();
    await expect(updatePinnedMessage(
      { BOT_TOKEN: 'test', DB: db }, -123, 'board_message_id', '<b>board</b>', null, 'court board'
    )).rejects.toThrow(/TimeoutError/);
    expect(methodsOf(requests)).toEqual(['editMessageText']);
    expect(db.runs).toHaveLength(0);
  });
});

describe('updatePinnedMessage with nothing to show', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const clear = (db) => updatePinnedMessage(
    { BOT_TOKEN: 'test', DB: db }, -123, 'board_message_id', null, null, 'court board'
  );

  it('deletes the empty board and forgets it', async () => {
    const requests = captureTelegram();
    const db = settingsDb();
    expect(await clear(db)).toBeNull();
    expect(methodsOf(requests)).toEqual(['deleteMessage']);
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].sql).toContain('board_message_id = NULL');
  });

  it('forgets a board somebody already deleted', async () => {
    captureTelegram(undefined, {
      deleteMessage: { ok: false, description: 'Bad Request: message to delete not found' },
    });
    const db = settingsDb();
    expect(await clear(db)).toBeNull();
    expect(db.runs).toHaveLength(1);
  });

  // The duplicate in the group: a board Telegram would not delete was unpinned
  // and forgotten while it still showed its last court, and the next booking
  // pinned a second board beside it.
  it('keeps a board Telegram will not delete, pinned and saying nothing is booked', async () => {
    const requests = captureTelegram(undefined, {
      deleteMessage: { ok: false, description: "Bad Request: message can't be deleted" },
    });
    const db = settingsDb();
    expect(await clear(db)).toBeNull();
    expect(methodsOf(requests)).toEqual(['deleteMessage', 'editMessageText']);
    expect(requests[1].body.message_id).toBe(55);
    expect(requests[1].body.text).toContain('No courts booked');
    expect(requests[1].body.reply_markup).toBeUndefined();
    expect(db.runs).toHaveLength(0);
  });

  it('edits the kept board in place when courts are booked again', async () => {
    const requests = captureTelegram();
    const db = settingsDb();
    const id = await updatePinnedMessage(
      { BOT_TOKEN: 'test', DB: db }, -123, 'board_message_id', '<b>board</b>', null, 'court board'
    );
    expect(id).toBe(55);
    expect(methodsOf(requests)).toEqual(['editMessageText']);
  });

  it('keeps the id and throws when the delete only failed for now', async () => {
    const requests = captureTelegram(undefined, {
      deleteMessage: { ok: false, description: 'Too Many Requests: retry after 5' },
    });
    const db = settingsDb();
    await expect(clear(db)).rejects.toThrow(/court board.*retry after 5/);
    expect(methodsOf(requests)).toEqual(['deleteMessage']);
    expect(db.runs).toHaveLength(0);
  });

  it('says the tab is settled when a settled tab cannot be deleted', async () => {
    const requests = captureTelegram(undefined, {
      deleteMessage: { ok: false, description: "Bad Request: message can't be deleted" },
    });
    const db = settingsDb({ board_message_id: 55, tab_message_id: 60 });
    expect(await updatePinnedMessage(
      { BOT_TOKEN: 'test', DB: db }, -123, 'tab_message_id', null, null, 'squash tab'
    )).toBeNull();
    expect(requests[1].body.message_id).toBe(60);
    expect(requests[1].body.text).toContain('Everyone is settled');
    expect(db.runs).toHaveLength(0);
  });
});
