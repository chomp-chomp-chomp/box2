// Persist decrypted messages in localStorage so returning members see history instantly.
// Only stores the last N messages per room to avoid bloating storage.

const MAX_CACHED = 100;
const KEY_PREFIX = 'msgCache:';

export interface CachedMessage {
  msgId: string;
  displayName: string;
  text: string;
  clientTs: number;
  createdAt: string;
}

export function getCachedMessages(roomId: string): CachedMessage[] {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + roomId);
    if (!raw) return [];
    return JSON.parse(raw) as CachedMessage[];
  } catch {
    return [];
  }
}

export function setCachedMessages(roomId: string, messages: CachedMessage[]): void {
  try {
    // Only keep the most recent N
    const trimmed = messages.slice(-MAX_CACHED);
    localStorage.setItem(KEY_PREFIX + roomId, JSON.stringify(trimmed));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

export function appendCachedMessage(roomId: string, msg: CachedMessage): void {
  const existing = getCachedMessages(roomId);
  // Deduplicate
  if (existing.some((m) => m.msgId === msg.msgId)) return;
  existing.push(msg);
  setCachedMessages(roomId, existing);
}
