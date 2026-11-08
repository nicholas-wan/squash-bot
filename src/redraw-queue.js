// The pinned board and tab are drawings of what is saved, redrawn after every
// change. Redraws of one message run one at a time within the isolate: two at
// once could land an older drawing last or, with nothing pinned yet, post and
// pin two. Each one reads the database when its turn comes, so a redraw that
// has not started yet already covers any change made before it starts. A
// second request while one is waiting therefore shares that one rather than
// queuing a third: five quick taps cost two redraws, not five.
//
// Shared only between calls for the same chat, because the redraw's answer
// (the pinned id, or the acting chat's own failure) is that chat's. Keyed by
// database handle, as the other per-isolate caches are, so tests never share.
const queues = new WeakMap();

export function serializedRedraw(db, key, chatId, draw) {
  let slots = queues.get(db);
  if (!slots) queues.set(db, (slots = new Map()));
  let slot = slots.get(key);
  if (!slot) slots.set(key, (slot = { tail: Promise.resolve(), waiting: null, chat: null }));
  if (slot.waiting && slot.chat === chatId) return slot.waiting;
  const run = slot.tail.catch(() => {}).then(() => {
    if (slot.waiting === run) slot.waiting = null;
    return draw();
  });
  slot.waiting = run;
  slot.chat = chatId;
  slot.tail = run;
  const forget = () => {
    if (slot.tail === run && slots.get(key) === slot) slots.delete(key);
  };
  run.then(forget, forget);
  return run;
}
