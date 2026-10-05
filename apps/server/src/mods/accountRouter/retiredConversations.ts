/**
 * Native conversations the account router retired (t3-mods: account-router).
 * The orchestrator's provider switch skips them when it picks the conversation a
 * thread returns to on an account (`rootProviderThreadsForProvider`), so the
 * return starts a new conversation with a summary, as a first visit does.
 *
 * Kept in memory only: the new conversation is the account's newest, so the
 * switch prefers it anyway once it exists, and a restart that forgets an entry
 * changes nothing.
 */
const LIMIT = 1_000;
const retired = new Set<string>();

export function retireConversation(providerThreadId: string): void {
  retired.add(providerThreadId);
  if (retired.size > LIMIT) retired.delete(retired.values().next().value!);
}

export function isRetiredConversation(providerThreadId: string): boolean {
  return retired.has(providerThreadId);
}
