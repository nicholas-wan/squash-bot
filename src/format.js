// How a court is named everywhere a person reads it. These live apart from
// the modules that render with them so the tab never has to reach back into
// bookings — which imports the tab — just to spell a court's name.

export function courtName(booking) {
  return String(booking.court).startsWith('Court ')
    ? String(booking.court) : `Court ${booking.court}`;
}

// Inline keyboard buttons ellipsize well before fifty characters on a normal
// phone, and what got cut was the slot count — the one thing the tap decision
// depends on. A numeric court compresses to "C4"; a named court keeps its name.
export function shortCourtName(booking) {
  const court = String(booking.court).trim();
  return /^\d+$/.test(court) ? `C${court}` : courtName(booking);
}
