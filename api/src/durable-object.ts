import { DurableObject } from 'cloudflare:workers';

interface Env {
  DB: D1Database;
  RATE_LIMIT?: {
    MAX_CONNECTIONS_PER_IP?: number;
    MAX_MESSAGES_PER_MINUTE?: number;
    MAX_MESSAGE_SIZE?: number;
  };
}

interface ClientMessage {
  type: 'message';
  msgId: string;
  ivB64: string;
  ciphertextB64: string;
  senderName?: string;
  keyFingerprint?: string;
  version: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RecipeRoom extends DurableObject {
  private connections: Set<WebSocket>;
  private connectionsByIp: Map<string, number>;
  private rateLimits: Map<string, RateLimitEntry>;
  private env: Env;
  private initialized: boolean;
  private roomId: string | null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.connections = new Set();
    this.connectionsByIp = new Map();
    this.rateLimits = new Map();
    this.env = env;
    this.initialized = false;
    this.roomId = null;
  }

  private ensureSchema(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS name_claims (
        display_name TEXT PRIMARY KEY,
        key_fingerprint TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      )
    `);
    this.initialized = true;
  }

  // Check if a name is available or belongs to this fingerprint
  private checkNameClaim(senderName: string, keyFingerprint: string): { ok: boolean; owner?: string } {
    this.ensureSchema();
    const row = this.ctx.storage.sql.exec(
      'SELECT key_fingerprint FROM name_claims WHERE display_name = ?',
      senderName
    ).one();

    if (!row) {
      // Name is unclaimed — register it
      this.ctx.storage.sql.exec(
        'INSERT INTO name_claims (display_name, key_fingerprint, claimed_at) VALUES (?, ?, ?)',
        senderName,
        keyFingerprint,
        new Date().toISOString()
      );
      return { ok: true };
    }

    if (row.key_fingerprint === keyFingerprint) {
      return { ok: true };
    }

    // Name belongs to a different key
    return { ok: false, owner: row.key_fingerprint as string };
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Extract roomId from the request URL (e.g., /api/rooms/:roomId/ws)
    const url = new URL(request.url);
    const wsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (wsMatch) {
      this.roomId = decodeURIComponent(wsMatch[1]);
    } else {
      // Fallback to DO name
      this.roomId = this.ctx.id.name || null;
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const maxConnectionsPerIp = this.env.RATE_LIMIT?.MAX_CONNECTIONS_PER_IP || 10;

    // Check connection limit per IP
    const currentConnections = this.connectionsByIp.get(ip) || 0;
    if (currentConnections >= maxConnectionsPerIp) {
      return new Response('Too many connections', { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.handleSession(server, ip);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleSession(ws: WebSocket, ip: string): Promise<void> {
    ws.accept();
    this.connections.add(ws);

    const currentCount = this.connectionsByIp.get(ip) || 0;
    this.connectionsByIp.set(ip, currentCount + 1);

    ws.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data as string);
        await this.handleMessage(ws, ip, data);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.addEventListener('close', () => {
      this.connections.delete(ws);
      const count = this.connectionsByIp.get(ip) || 0;
      if (count <= 1) {
        this.connectionsByIp.delete(ip);
      } else {
        this.connectionsByIp.set(ip, count - 1);
      }
    });

    ws.addEventListener('error', () => {
      this.connections.delete(ws);
      const count = this.connectionsByIp.get(ip) || 0;
      if (count <= 1) {
        this.connectionsByIp.delete(ip);
      } else {
        this.connectionsByIp.set(ip, count - 1);
      }
    });
  }

  async handleMessage(ws: WebSocket, ip: string, data: any): Promise<void> {
    // Rate limiting
    const maxMessagesPerMinute = this.env.RATE_LIMIT?.MAX_MESSAGES_PER_MINUTE || 30;
    const now = Date.now();
    const rateLimit = this.rateLimits.get(ip);

    if (rateLimit && now < rateLimit.resetAt) {
      if (rateLimit.count >= maxMessagesPerMinute) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
        return;
      }
      rateLimit.count++;
    } else {
      this.rateLimits.set(ip, {
        count: 1,
        resetAt: now + 60000, // 1 minute
      });
    }

    // Validate message
    if (data.type !== 'message') {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message type' }));
      return;
    }

    const msg = data as ClientMessage;
    const maxMessageSize = this.env.RATE_LIMIT?.MAX_MESSAGE_SIZE || 16384;

    if (!msg.msgId || !msg.ivB64 || !msg.ciphertextB64 || typeof msg.version !== 'number') {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing required fields' }));
      return;
    }

    if (msg.ciphertextB64.length > maxMessageSize) {
      ws.send(JSON.stringify({ type: 'error', message: 'Message too large' }));
      return;
    }

    // Enforce name uniqueness: if senderName and keyFingerprint are provided,
    // verify this name belongs to (or is now claimed by) this key
    if (msg.senderName && msg.keyFingerprint) {
      const claim = this.checkNameClaim(msg.senderName, msg.keyFingerprint);
      if (!claim.ok) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'name_taken',
          message: `The name "${msg.senderName}" is already claimed by another user in this room.`,
        }));
        return;
      }
    }

    const roomId = this.roomId || this.ctx.id.name || 'unknown';
    const createdAt = new Date().toISOString();

    // Build broadcast message
    const broadcastMsg = {
      type: 'message',
      msgId: msg.msgId,
      version: msg.version,
      createdAt,
      ivB64: msg.ivB64,
      ciphertextB64: msg.ciphertextB64,
      senderName: msg.senderName || null,
    };

    // Broadcast to all connected clients FIRST (real-time delivery)
    const messageStr = JSON.stringify(broadcastMsg);
    this.connections.forEach((client) => {
      if (client.readyState === 1) {
        client.send(messageStr);
      }
    });

    // Then persist to D1 (async, non-blocking for real-time)
    try {
      await this.env.DB.prepare(
        'INSERT INTO messages (room_id, msg_id, version, created_at, iv_b64, ciphertext_b64, sender_name) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(
          roomId,
          msg.msgId,
          msg.version,
          createdAt,
          msg.ivB64,
          msg.ciphertextB64,
          msg.senderName || null
        )
        .run();
    } catch (err) {
      console.error('Failed to persist message to D1:', err);
      // Message was already broadcast — just log the storage failure
    }
  }
}
