import { RecipeRoom } from './durable-object';

export { RecipeRoom };

interface Env {
  DB: D1Database;
  RECIPE_ROOM: DurableObjectNamespace;
  ADMIN_TOKEN: string;
  ENVIRONMENT: string;
}

interface Room {
  room_id: string;
  title: string | null;
  salt_b64: string;
  kdf_iters: number;
  version: number;
  created_at: string;
}

interface Message {
  room_id: string;
  msg_id: string;
  version: number;
  created_at: string;
  iv_b64: string;
  ciphertext_b64: string;
  sender_name: string | null;
}

// Generate URL-safe random ID
function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// Generate random salt (32 bytes base64)
function generateSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

// CORS headers
function corsHeaders(origin: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

// JSON response helper
function jsonResponse(data: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

// Error response helper
function errorResponse(message: string, status = 400, origin: string | null = null): Response {
  return jsonResponse({ error: message }, status, origin);
}

// Verify admin token
function verifyAdmin(request: Request, env: Env): boolean {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const token = authHeader.slice(7);
  return token === env.ADMIN_TOKEN;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get('Origin');

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      // Public endpoints
      if (path.match(/^\/api\/rooms\/[^/]+$/) && request.method === 'GET') {
        return await handleGetRoom(request, env, origin);
      }

      if (path.match(/^\/api\/rooms\/[^/]+\/history$/) && request.method === 'GET') {
        return await handleGetHistory(request, env, origin);
      }

      if (path.match(/^\/api\/rooms\/[^/]+\/ws$/) && request.method === 'GET') {
        return await handleWebSocket(request, env);
      }

      // Admin endpoints
      if (path === '/api/admin/rooms' && request.method === 'POST') {
        if (!verifyAdmin(request, env)) {
          return errorResponse('Unauthorized', 401, origin);
        }
        return await handleCreateRoom(request, env, origin);
      }

      if (path.match(/^\/api\/admin\/rooms\/[^/]+\/rotate$/) && request.method === 'POST') {
        if (!verifyAdmin(request, env)) {
          return errorResponse('Unauthorized', 401, origin);
        }
        return await handleRotatePassphrase(request, env, origin);
      }

      if (path.match(/^\/api\/admin\/rooms\/[^/]+$/) && request.method === 'PATCH') {
        if (!verifyAdmin(request, env)) {
          return errorResponse('Unauthorized', 401, origin);
        }
        return await handleUpdateRoom(request, env, origin);
      }

      return errorResponse('Not found', 404, origin);
    } catch (err) {
      console.error('Error:', err);
      return errorResponse('Internal server error', 500, origin);
    }
  },
};

// GET /api/rooms/:roomId
async function handleGetRoom(request: Request, env: Env, origin: string | null): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[3];

  const room = await env.DB.prepare(
    'SELECT room_id, title, salt_b64, kdf_iters, version FROM rooms WHERE room_id = ?'
  ).bind(roomId).first<Room>();

  if (!room) {
    return errorResponse('Room not found', 404, origin);
  }

  return jsonResponse({
    roomId: room.room_id,
    title: room.title,
    saltB64: room.salt_b64,
    kdfIters: room.kdf_iters,
    version: room.version,
  }, 200, origin);
}

// GET /api/rooms/:roomId/history
async function handleGetHistory(request: Request, env: Env, origin: string | null): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[3];
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const before = url.searchParams.get('before');
  const version = url.searchParams.get('version');

  let query = 'SELECT msg_id, version, created_at, iv_b64, ciphertext_b64, sender_name FROM messages WHERE room_id = ?';
  const params: (string | number)[] = [roomId];

  if (before) {
    query += ' AND created_at < ?';
    params.push(before);
  }

  if (version) {
    query += ' AND version = ?';
    params.push(parseInt(version));
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const stmt = env.DB.prepare(query);
  const result = await stmt.bind(...params).all<Message>();

  const messages = (result.results || []).map(m => ({
    msgId: m.msg_id,
    version: m.version,
    createdAt: m.created_at,
    ivB64: m.iv_b64,
    ciphertextB64: m.ciphertext_b64,
    senderName: m.sender_name,
  })).reverse();

  return jsonResponse({ messages }, 200, origin);
}

// GET /api/rooms/:roomId/ws - WebSocket upgrade
async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[3];

  // Verify room exists
  const room = await env.DB.prepare(
    'SELECT room_id FROM rooms WHERE room_id = ?'
  ).bind(roomId).first();

  if (!room) {
    return new Response('Room not found', { status: 404 });
  }

  // Get client IP for rate limiting
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';

  // Forward to Durable Object
  const id = env.RECIPE_ROOM.idFromName(roomId);
  const stub = env.RECIPE_ROOM.get(id);

  // Clone request with additional headers
  const newHeaders = new Headers(request.headers);
  newHeaders.set('X-Room-Id', roomId);
  newHeaders.set('X-Client-IP', clientIp);

  const newRequest = new Request(request.url, {
    method: request.method,
    headers: newHeaders,
  });

  return stub.fetch(newRequest);
}

// POST /api/admin/rooms
async function handleCreateRoom(request: Request, env: Env, origin: string | null): Promise<Response> {
  const body = await request.json() as { title?: string; kdfIters?: number };
  const roomId = generateRoomId();
  const title = body.title || null;
  const saltB64 = generateSalt();
  const kdfIters = body.kdfIters || 100000;
  const createdAt = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO rooms (room_id, title, salt_b64, kdf_iters, version, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  ).bind(roomId, title, saltB64, kdfIters, createdAt).run();

  return jsonResponse({
    roomId,
    title,
    saltB64,
    kdfIters,
    version: 1,
  }, 201, origin);
}

// POST /api/admin/rooms/:roomId/rotate
async function handleRotatePassphrase(request: Request, env: Env, origin: string | null): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[4];

  // Get current room
  const room = await env.DB.prepare(
    'SELECT version FROM rooms WHERE room_id = ?'
  ).bind(roomId).first<{ version: number }>();

  if (!room) {
    return errorResponse('Room not found', 404, origin);
  }

  const newVersion = room.version + 1;
  const newSaltB64 = generateSalt();
  const body = await request.json().catch(() => ({})) as { kdfIters?: number };
  const kdfIters = body.kdfIters || 100000;

  await env.DB.prepare(
    'UPDATE rooms SET salt_b64 = ?, kdf_iters = ?, version = ? WHERE room_id = ?'
  ).bind(newSaltB64, kdfIters, newVersion, roomId).run();

  return jsonResponse({
    roomId,
    saltB64: newSaltB64,
    kdfIters,
    version: newVersion,
  }, 200, origin);
}

// PATCH /api/admin/rooms/:roomId
async function handleUpdateRoom(request: Request, env: Env, origin: string | null): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.pathname.split('/')[4];
  const body = await request.json() as { title?: string };

  const room = await env.DB.prepare(
    'SELECT room_id FROM rooms WHERE room_id = ?'
  ).bind(roomId).first();

  if (!room) {
    return errorResponse('Room not found', 404, origin);
  }

  if (body.title !== undefined) {
    await env.DB.prepare(
      'UPDATE rooms SET title = ? WHERE room_id = ?'
    ).bind(body.title, roomId).run();
  }

  return jsonResponse({ success: true }, 200, origin);
}
