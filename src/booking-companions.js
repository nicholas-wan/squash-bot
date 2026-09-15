import { identity } from './players.js';

// Telegram entity offsets and JavaScript indices both use UTF-16.
export function parseBookingCompanions(text, msg) {
  const players = [];
  const offset = (msg.text || '').lastIndexOf(text);
  const ranges = [];
  for (const entity of msg.entities || []) {
    if (entity.type !== 'text_mention' || !entity.user || offset < 0) continue;
    const start = entity.offset - offset;
    if (start < 0 || start + entity.length > text.length) continue;
    players.push(identity(entity.user));
    ranges.push([start, start + entity.length]);
  }
  let details = text;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    details = details.slice(0, start) + ' '.repeat(end - start) + details.slice(end);
  }
  details = details.replace(/(^|\s)@([a-zA-Z0-9_]+)\b/g, (_, space, username) => {
    players.push(identity({ username }));
    return space;
  });
  let plusOne = false;
  details = details.replace(/(^|\s)\+1(?=\s|$|[,.;!])/g, (_, space) => {
    plusOne = true;
    return space;
  });
  return { details: details.trim(), companions: { players, plusOne } };
}
