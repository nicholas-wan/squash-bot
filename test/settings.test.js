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
// answers with whatever this particular test is about.
function captureTelegram(editResponse = { ok: true, result: { message_id: 55 } }) {
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const href = String(url);
    requests.push({ url: href, body: JSON.parse(init.body) });
    const body = href.endsWith('/editMessageText')
      ? editResponse
      : { ok: true, result: { message_id: 77 } };
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
    expect(methodsOf(requests)).toEqual(['editMessageText', 'sendMessage', 'pinChatMessage']);
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
