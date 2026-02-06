const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export interface RoomInfo {
  roomId: string;
  title: string | null;
  saltB64: string;
  kdfIters: number;
  version: number;
}

export interface HistoryMessage {
  msgId: string;
  version: number;
  createdAt: string;
  ivB64: string;
  ciphertextB64: string;
  senderName: string | null;
}

function adminApiError(status: number, fallback: string): Error {
  if (status === 401) return new Error('Invalid admin token');
  if (status === 404) return new Error('Recipe not found');
  if (status === 405) {
    return new Error(
      'Admin API endpoint rejected this method (405). Verify VITE_API_BASE_URL points to the Worker/API host, not the Pages site.'
    );
  }
  return new Error(fallback);
}

// Public endpoints
export async function getRoom(roomId: string): Promise<RoomInfo> {
  const res = await fetch(`${API_BASE}/api/rooms/${encodeURIComponent(roomId)}`);
  if (!res.ok) {
    throw new Error(res.status === 404 ? 'Recipe not found' : 'Failed to fetch recipe');
  }
  return res.json();
}

export async function getHistory(
  roomId: string,
  options?: { limit?: number; before?: string; version?: number }
): Promise<{ messages: HistoryMessage[] }> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', options.limit.toString());
  if (options?.before) params.set('before', options.before);
  if (options?.version) params.set('version', options.version.toString());

  const url = `${API_BASE}/api/rooms/${encodeURIComponent(roomId)}/history${
    params.toString() ? '?' + params.toString() : ''
  }`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Failed to fetch history');
  }
  return res.json();
}

export function getWebSocketUrl(roomId: string): string {
  const base = API_BASE || window.location.origin;
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsBase = base.replace(/^http(s)?:/, wsProtocol);
  return `${wsBase}/api/rooms/${encodeURIComponent(roomId)}/ws`;
}

// Admin endpoints
export async function createRoom(
  adminToken: string,
  options?: { title?: string; kdfIters?: number }
): Promise<RoomInfo> {
  const res = await fetch(`${API_BASE}/api/admin/rooms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(options || {}),
  });
  if (!res.ok) {
    throw adminApiError(res.status, 'Failed to create recipe');
  }
  return res.json();
}

export async function rotatePassphrase(
  adminToken: string,
  roomId: string,
  options?: { kdfIters?: number }
): Promise<RoomInfo> {
  const res = await fetch(`${API_BASE}/api/admin/rooms/${encodeURIComponent(roomId)}/rotate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(options || {}),
  });
  if (!res.ok) {
    throw adminApiError(res.status, 'Failed to rotate passphrase');
  }
  return res.json();
}

export async function updateRoom(
  adminToken: string,
  roomId: string,
  updates: { title?: string }
): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/api/admin/rooms/${encodeURIComponent(roomId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    throw adminApiError(res.status, 'Failed to update recipe');
  }
  return res.json();
}
