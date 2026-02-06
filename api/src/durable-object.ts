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

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.connections = new Set();
    this.connectionsByIp = new Map();
    this.rateLimits = new Map();
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
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

    // Extract room ID from the Durable Object name
    const roomId = await this.getRoomId();

    // Store message in D1
    try {
      const createdAt = new Date().toISOString();
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

      // Broadcast to all connected clients
      const broadcastMsg = {
        type: 'message',
        msgId: msg.msgId,
        version: msg.version,
        createdAt,
        ivB64: msg.ivB64,
        ciphertextB64: msg.ciphertextB64,
        senderName: msg.senderName || null,
      };

      const messageStr = JSON.stringify(broadcastMsg);
      this.connections.forEach((client) => {
        if (client.readyState === 1) {
          // OPEN
          client.send(messageStr);
        }
      });
    } catch (err) {
      console.error('Failed to store message:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to store message' }));
    }
  }

  private async getRoomId(): Promise<string> {
    // The Durable Object ID name is the room ID
    // This is set when creating the Durable Object via idFromName(roomId)
    return this.ctx.id.name || 'unknown';
  }
}
