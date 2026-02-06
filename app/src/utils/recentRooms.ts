const STORAGE_KEY = 'recentRooms';
const MAX_RECENT = 10;

export interface RecentRoom {
  roomId: string;
  title: string;
  lastVisited: number;
}

export function getRecentRooms(): RecentRoom[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RecentRoom[];
  } catch {
    return [];
  }
}

export function saveRecentRoom(roomId: string, title: string): void {
  const rooms = getRecentRooms().filter((r) => r.roomId !== roomId);
  rooms.unshift({ roomId, title, lastVisited: Date.now() });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms.slice(0, MAX_RECENT)));
}

export function removeRecentRoom(roomId: string): void {
  const rooms = getRecentRooms().filter((r) => r.roomId !== roomId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));
}
