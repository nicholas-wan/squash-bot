// A link that opens the Mini App over the chat. A group cannot carry a web_app
// button, but a plain URL button to the app's direct link can, and startapp
// tells the app which group it was opened from — the launch data Telegram
// signs does not. A booking id adds "_b<id>", which takes an admin straight to
// that court; 'tab' adds "_tab", which opens on the tab. The sheet opens
// compact, half height, so the chat it came from stays in view.
// Null until MINI_APP_URL holds the link BotFather gave, and then every
// button falls back to the chat panels it replaced.
export function miniAppLink(env, chatId, target = null) {
  if (!env.MINI_APP_URL) return null;
  let link;
  try {
    link = new URL(env.MINI_APP_URL);
  } catch {
    console.log(`MINI_APP_URL is not a URL: ${env.MINI_APP_URL}`);
    return null;
  }
  const suffix = target === 'tab' ? '_tab' : target ? `_b${target}` : '';
  link.searchParams.set('startapp', `g${chatId}${suffix}`);
  link.searchParams.set('mode', 'compact');
  return link.toString();
}
