interface Env {
  DB: D1Database;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface MessageFrame {
  type: 'msg';
  msgId: string;
  version: number;
  ivB64: string;
  ciphertextB64: string;
  clientTs: number;
}

interface BroadcastMessage {
  type: 'msg';
  msgId: string;
  version: number;
  ivB64: string;
  ciphertextB64: string;
  createdAt: string;
}

// Rate limiting configuration
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_MESSAGES_PER_MINUTE = 30;
const MAX_MESSAGE_SIZE = 16384; // 16KB
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute

export class RecipeRoom implements DurableObject {
  private sessions: Map<WebSocket, { ip: string; connectedAt: number }> = new Map();
  private ipConnectionCounts: Map<string, number> = new Map();
  private messageRateLimits: Map<string, RateLimitEntry> = new Map();
  private roomId: string | null = null;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract room ID and client IP from headers
    this.roomId = request.headers.get('X-Room-Id');
    const clientIp = request.headers.get('X-Client-IP') || 'unknown';

    // Check WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Check connection limit per IP
    const currentConnections = this.ipConnectionCounts.get(clientIp) || 0;
    if (currentConnections >= MAX_CONNECTIONS_PER_IP) {
      return new Response('Too many connections from this IP', { status: 429 });
    }

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket
    server.accept();

    // Track the session
    this.sessions.set(server, { ip: clientIp, connectedAt: Date.now() });
    this.ipConnectionCounts.set(clientIp, currentConnections + 1);

    // Set up message handler
    server.addEventListener('message', async (event) => {
      await this.handleMessage(server, clientIp, event.data);
    });

    // Set up close handler
    server.addEventListener('close', () => {
      this.handleClose(server, clientIp);
    });

    server.addEventListener('error', () => {
      this.handleClose(server, clientIp);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleMessage(ws: WebSocket, clientIp: string, data: string | ArrayBuffer): Promise<void> {
    try {
      // Check message size
      const messageSize = typeof data === 'string' ? data.length : data.byteLength;
      if (messageSize > MAX_MESSAGE_SIZE) {
        ws.send(JSON.stringify({ type: 'error', error: 'Message too large' }));
        return;
      }

      // Rate limiting
      if (!this.checkRateLimit(clientIp)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Rate limit exceeded' }));
        return;
      }

      // Parse message
      const messageStr = typeof data === 'string' ? data : new TextDecoder().decode(data);
      const message = JSON.parse(messageStr) as MessageFrame;

      // Validate message structure
      if (message.type !== 'msg' || !message.msgId || !message.version || !message.ivB64 || !message.ciphertextB64) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid message format' }));
        return;
      }

      // Validate msgId format (should be alphanumeric/dash/underscore)
      if (!/^[a-zA-Z0-9_-]+$/.test(message.msgId) || message.msgId.length > 64) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid message ID' }));
        return;
      }

      // Validate base64 format
      if (!this.isValidBase64(message.ivB64) || !this.isValidBase64(message.ciphertextB64)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid base64 encoding' }));
        return;
      }

      // Store in D1
      const createdAt = new Date().toISOString();

      await this.env.DB.prepare(
        'INSERT INTO messages (room_id, msg_id, version, created_at, iv_b64, ciphertext_b64) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(
        this.roomId,
        message.msgId,
        message.version,
        createdAt,
        message.ivB64,
        message.ciphertextB64
      ).run();

      // Broadcast to all connected clients
      const broadcastMsg: BroadcastMessage = {
        type: 'msg',
        msgId: message.msgId,
        version: message.version,
        ivB64: message.ivB64,
        ciphertextB64: message.ciphertextB64,
        createdAt,
      };

      const broadcastStr = JSON.stringify(broadcastMsg);
      for (const [session] of this.sessions) {
        try {
          session.send(broadcastStr);
        } catch {
          // Client disconnected, will be cleaned up
        }
      }
    } catch (err) {
      console.error('Message handling error:', err);
      ws.send(JSON.stringify({ type: 'error', error: 'Failed to process message' }));
    }
  }

  private handleClose(ws: WebSocket, clientIp: string): void {
    this.sessions.delete(ws);
    const currentCount = this.ipConnectionCounts.get(clientIp) || 0;
    if (currentCount <= 1) {
      this.ipConnectionCounts.delete(clientIp);
    } else {
      this.ipConnectionCounts.set(clientIp, currentCount - 1);
    }
  }

  private checkRateLimit(clientIp: string): boolean {
    const now = Date.now();
    const entry = this.messageRateLimits.get(clientIp);

    if (!entry || now > entry.resetAt) {
      this.messageRateLimits.set(clientIp, {
        count: 1,
        resetAt: now + RATE_LIMIT_WINDOW_MS,
      });
      return true;
    }

    if (entry.count >= MAX_MESSAGES_PER_MINUTE) {
      return false;
    }

    entry.count++;
    return true;
  }

  private isValidBase64(str: string): boolean {
    if (!str || str.length > 100000) return false;
    try {
      // Check for valid base64 characters
      return /^[A-Za-z0-9+/=]+$/.test(str);
    } catch {
      return false;
    }
  }
}
