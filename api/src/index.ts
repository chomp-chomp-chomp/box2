export { RecipeRoom } from './durable-object';

export interface Env {
  RECIPE_ROOM: DurableObjectNamespace;
  DB: D1Database;
  ADMIN_TOKEN?: string;
  ENVIRONMENT?: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function corsResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(data: any, status = 200, cacheSeconds = 0): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cacheSeconds > 0) {
    headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
  }
  return corsResponse(
    new Response(JSON.stringify(data), { status, headers })
  );
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

function requireAdminAuth(request: Request, env: Env): void {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }
  const token = authHeader.slice(7);
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    throw new Error('Unauthorized');
  }
}

function generateRoomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function generateSalt(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // Admin endpoints
    if (url.pathname.startsWith('/api/admin/')) {
      try {
        requireAdminAuth(request, env);
      } catch (err) {
        return errorResponse('Unauthorized', 401);
      }

      // GET /api/admin/rooms - List all rooms
      if (url.pathname === '/api/admin/rooms' && request.method === 'GET') {
        try {
          const result = await env.DB.prepare(
            'SELECT r.room_id, r.title, r.version, r.created_at, COUNT(m.msg_id) as message_count FROM rooms r LEFT JOIN messages m ON r.room_id = m.room_id GROUP BY r.room_id ORDER BY r.created_at DESC'
          ).all();

          const rooms = (result.results || []).map((row: any) => ({
            roomId: row.room_id,
            title: row.title,
            version: row.version,
            createdAt: row.created_at,
            messageCount: row.message_count,
          }));

          return jsonResponse({ rooms });
        } catch (err) {
          return errorResponse('Failed to list rooms', 500);
        }
      }

      // POST /api/admin/rooms - Create new room
      if (url.pathname === '/api/admin/rooms' && request.method === 'POST') {
        try {
          const body = await request.json() as { title?: string; kdfIters?: number };
          const roomId = generateRoomId();
          const saltB64 = generateSalt();
          const kdfIters = body.kdfIters || 100000;
          const title = body.title || null;
          const createdAt = new Date().toISOString();

          await env.DB.prepare(
            'INSERT INTO rooms (room_id, title, salt_b64, kdf_iters, version, created_at) VALUES (?, ?, ?, ?, 1, ?)'
          )
            .bind(roomId, title, saltB64, kdfIters, createdAt)
            .run();

          return jsonResponse({
            roomId,
            title,
            saltB64,
            kdfIters,
            version: 1,
          });
        } catch (err) {
          return errorResponse('Failed to create room', 500);
        }
      }

      // POST /api/admin/rooms/:roomId/rotate - Rotate passphrase
      const rotateMatch = url.pathname.match(/^\/api\/admin\/rooms\/([^/]+)\/rotate$/);
      if (rotateMatch && request.method === 'POST') {
        const roomId = decodeURIComponent(rotateMatch[1]);
        try {
          const body = await request.json() as { kdfIters?: number };
          const room = await env.DB.prepare('SELECT * FROM rooms WHERE room_id = ?')
            .bind(roomId)
            .first();

          if (!room) {
            return errorResponse('Room not found', 404);
          }

          const newVersion = (room.version as number) + 1;
          const newSalt = generateSalt();
          const kdfIters = body.kdfIters || 100000;

          await env.DB.prepare(
            'UPDATE rooms SET salt_b64 = ?, kdf_iters = ?, version = ? WHERE room_id = ?'
          )
            .bind(newSalt, kdfIters, newVersion, roomId)
            .run();

          return jsonResponse({
            roomId,
            title: room.title,
            saltB64: newSalt,
            kdfIters,
            version: newVersion,
          });
        } catch (err) {
          return errorResponse('Failed to rotate passphrase', 500);
        }
      }

      // PATCH /api/admin/rooms/:roomId - Update room
      const updateMatch = url.pathname.match(/^\/api\/admin\/rooms\/([^/]+)$/);
      if (updateMatch && request.method === 'PATCH') {
        const roomId = decodeURIComponent(updateMatch[1]);
        try {
          const body = await request.json() as { title?: string };
          await env.DB.prepare('UPDATE rooms SET title = ? WHERE room_id = ?')
            .bind(body.title || null, roomId)
            .run();
          return jsonResponse({ success: true });
        } catch (err) {
          return errorResponse('Failed to update room', 500);
        }
      }

      // DELETE /api/admin/rooms/:roomId - Delete room and all its messages
      const deleteMatch = url.pathname.match(/^\/api\/admin\/rooms\/([^/]+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        const roomId = decodeURIComponent(deleteMatch[1]);
        try {
          const room = await env.DB.prepare('SELECT room_id FROM rooms WHERE room_id = ?')
            .bind(roomId)
            .first();

          if (!room) {
            return errorResponse('Room not found', 404);
          }

          // Delete messages first, then the room
          await env.DB.prepare('DELETE FROM messages WHERE room_id = ?')
            .bind(roomId)
            .run();
          await env.DB.prepare('DELETE FROM rooms WHERE room_id = ?')
            .bind(roomId)
            .run();

          return jsonResponse({ success: true, roomId });
        } catch (err) {
          return errorResponse('Failed to delete room', 500);
        }
      }

      return errorResponse('Not found', 404);
    }

    // GET /api/rooms/:roomId - Get room info
    const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
    if (roomMatch && request.method === 'GET') {
      const roomId = decodeURIComponent(roomMatch[1]);
      try {
        const room = await env.DB.prepare('SELECT * FROM rooms WHERE room_id = ?')
          .bind(roomId)
          .first();

        if (!room) {
          return errorResponse('Room not found', 404);
        }

        return jsonResponse({
          roomId: room.room_id,
          title: room.title,
          saltB64: room.salt_b64,
          kdfIters: room.kdf_iters,
          version: room.version,
        }, 200, 60);
      } catch (err) {
        return errorResponse('Failed to fetch room', 500);
      }
    }

    // GET /api/rooms/:roomId/history - Get message history
    const historyMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/history$/);
    if (historyMatch && request.method === 'GET') {
      const roomId = decodeURIComponent(historyMatch[1]);
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const before = url.searchParams.get('before');
      const version = url.searchParams.get('version');

      try {
        let query = 'SELECT * FROM messages WHERE room_id = ?';
        const bindings: any[] = [roomId];

        if (version) {
          query += ' AND version = ?';
          bindings.push(parseInt(version));
        }

        if (before) {
          query += ' AND created_at < ?';
          bindings.push(before);
        }

        query += ' ORDER BY created_at DESC LIMIT ?';
        bindings.push(limit);

        const result = await env.DB.prepare(query).bind(...bindings).all();

        const messages = (result.results || []).map((row: any) => ({
          msgId: row.msg_id,
          version: row.version,
          createdAt: row.created_at,
          ivB64: row.iv_b64,
          ciphertextB64: row.ciphertext_b64,
          senderName: row.sender_name,
        }));

        return jsonResponse({ messages });
      } catch (err) {
        return errorResponse('Failed to fetch history', 500);
      }
    }

    // WebSocket upgrade for /api/rooms/:roomId/ws
    const wsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (wsMatch) {
      const roomId = decodeURIComponent(wsMatch[1]);

      // Verify room exists
      const room = await env.DB.prepare('SELECT room_id FROM rooms WHERE room_id = ?')
        .bind(roomId)
        .first();

      if (!room) {
        return errorResponse('Room not found', 404);
      }

      // Get Durable Object
      const id = env.RECIPE_ROOM.idFromName(roomId);
      const stub = env.RECIPE_ROOM.get(id);

      // Forward the request to the Durable Object
      return stub.fetch(request);
    }

    return errorResponse('Not found', 404);
  },
};
