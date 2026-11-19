/**
 * Decides whether the open chat stays open when the active tab's site changes.
 * Only a KNOWN different site closes it. A momentarily unknown address (a page that is loading) or a chat the list has
 * not caught up with yet must not, and all-sites chats follow you everywhere.
 */
export function keepChat(chat: { host: string; scope?: string } | undefined, host: string | null): boolean {
  if (!host || !chat) return true;
  return chat.host === host || chat.scope === 'global';
}
