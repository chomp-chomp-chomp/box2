import { useState, useEffect, useRef, FormEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getRoom, getHistory, getWebSocketUrl, RoomInfo, HistoryMessage } from '../utils/api';
import { saveRecentRoom } from '../utils/recentRooms';
import { getCachedMessages, setCachedMessages, appendCachedMessage } from '../utils/messageCache';
import {
  deriveKeyPBKDF2,
  encryptPayload,
  decryptPayload,
  generateMsgId,
  MessagePayload,
  generateSigningKeypair,
  exportPublicKeyJwk,
  importPublicKeyJwk,
  signMessage,
  verifySignature,
  computeKeyFingerprint,
} from '../utils/crypto';
import {
  getOwnKeypair,
  saveOwnKeypair,
  getTrustedKey,
  saveTrustedKey,
  jwkEqual,
  TrustStatus,
} from '../utils/keyStore';

interface DecryptedMessage {
  msgId: string;
  displayName: string;
  text: string;
  clientTs: number;
  createdAt: string;
  isOwn: boolean;
  error?: boolean;
  trustStatus: TrustStatus;
}

function TrustIndicator({ status }: { status: TrustStatus }) {
  switch (status) {
    case 'verified':
      return (
        <span className="trust-indicator trust-verified" title="Verified sender (key matches)">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      );
    case 'new':
      return (
        <span className="trust-indicator trust-new" title="New sender (key stored on first use)">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <circle cx="5" cy="5" r="3" fill="currentColor"/>
          </svg>
        </span>
      );
    case 'mismatch':
      return (
        <span className="trust-indicator trust-mismatch" title="Warning: sender key changed!">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6 2L1 10.5H11L6 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
            <line x1="6" y1="5.5" x2="6" y2="7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <circle cx="6" cy="9" r="0.6" fill="currentColor"/>
          </svg>
        </span>
      );
    case 'unsigned':
    default:
      return null;
  }
}

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();

  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showNameModal, setShowNameModal] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [signingActive, setSigningActive] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const signingKeyRef = useRef<{ privateKey: CryptoKey; publicKeyJwk: JsonWebKey; fingerprint: string } | null>(null);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Initialize signing keypair when displayName and roomId are set
  useEffect(() => {
    if (!roomId || !displayName || showNameModal) return;

    const initKeypair = async () => {
      try {
        let publicKeyJwk: JsonWebKey;
        let privateKey: CryptoKey;

        const stored = await getOwnKeypair(roomId, displayName);
        if (stored) {
          // Re-import private key from stored JWK
          privateKey = await crypto.subtle.importKey(
            'jwk',
            stored.privateKeyJwk,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['sign']
          );
          publicKeyJwk = stored.publicKeyJwk;
        } else {
          // Generate new keypair
          const keypair = await generateSigningKeypair();
          publicKeyJwk = await exportPublicKeyJwk(keypair.publicKey);
          const privateKeyJwk = await crypto.subtle.exportKey('jwk', keypair.privateKey);
          await saveOwnKeypair(roomId, displayName, { publicKeyJwk, privateKeyJwk });
          privateKey = keypair.privateKey;
        }

        const fingerprint = await computeKeyFingerprint(publicKeyJwk);
        signingKeyRef.current = { privateKey, publicKeyJwk, fingerprint };
        setSigningActive(true);
      } catch (err) {
        console.error('Failed to initialize signing keypair:', err);
      }
    };

    initKeypair();
  }, [roomId, displayName, showNameModal]);

  // Load room and credentials
  useEffect(() => {
    const loadRoom = async () => {
      if (!roomId) {
        navigate('/');
        return;
      }

      // Get stored credentials (check localStorage, fall back to sessionStorage for migration)
      const stored = localStorage.getItem(`recipe:${roomId}`) || sessionStorage.getItem(`recipe:${roomId}`);
      if (!stored) {
        navigate('/');
        return;
      }

      // Migrate sessionStorage to localStorage if needed
      if (!localStorage.getItem(`recipe:${roomId}`) && sessionStorage.getItem(`recipe:${roomId}`)) {
        localStorage.setItem(`recipe:${roomId}`, stored);
      }

      const { passphrase: storedPassphrase } = JSON.parse(stored);

      // Get stored display name
      const storedName = localStorage.getItem(`displayName:${roomId}`);
      if (storedName) {
        setDisplayName(storedName);
      } else {
        setShowNameModal(true);
      }

      // Show cached messages immediately while we load fresh data
      const cached = getCachedMessages(roomId);
      if (cached.length > 0) {
        setMessages(cached.map((m) => ({
          ...m,
          isOwn: false,
          error: false,
          trustStatus: 'unsigned' as TrustStatus,
        })));
        setLoading(false);
      }

      try {
        // Fetch room metadata
        const roomInfo = await getRoom(roomId);
        setRoom(roomInfo);

        // Track this room for quick switching
        saveRecentRoom(roomId, roomInfo.title || 'Untitled Recipe');

        // Derive encryption key
        const key = await deriveKeyPBKDF2(
          storedPassphrase,
          roomInfo.saltB64,
          roomInfo.kdfIters
        );
        setCryptoKey(key);

        // Load history (will replace cached messages with verified ones)
        await loadHistory(roomId, key);

        setLoading(false);
      } catch (err) {
        console.error('Failed to load room:', err);
        setError("Couldn't open this recipe.");
        setLoading(false);
      }
    };

    loadRoom();
  }, [roomId, navigate]);

  // Verify signature and check trust store
  const verifyAndCheckTrust = async (
    payload: MessagePayload,
    msgId: string,
    currentRoomId: string
  ): Promise<TrustStatus> => {
    // No signature = legacy unsigned message
    if (!payload.signatureB64 || !payload.senderPublicKeyJwk) {
      return 'unsigned';
    }

    try {
      // Import the sender's public key from the payload
      const senderKey = await importPublicKeyJwk(payload.senderPublicKeyJwk);

      // Verify the signature
      const valid = await verifySignature(
        senderKey,
        payload.signatureB64,
        payload.text,
        payload.displayName,
        payload.clientTs,
        msgId
      );

      if (!valid) {
        return 'mismatch';
      }

      // Check trust store
      const trusted = await getTrustedKey(currentRoomId, payload.displayName);

      if (!trusted) {
        // First time seeing this user — store key (TOFU)
        await saveTrustedKey(currentRoomId, payload.displayName, payload.senderPublicKeyJwk);
        return 'new';
      }

      if (jwkEqual(trusted.publicKeyJwk, payload.senderPublicKeyJwk)) {
        return 'verified';
      }

      // Key mismatch — possible impersonation
      return 'mismatch';
    } catch (err) {
      console.error('Signature verification failed:', err);
      return 'mismatch';
    }
  };

  // Load message history
  const loadHistory = async (
    currentRoomId: string,
    key: CryptoKey,
  ) => {
    try {
      // Don't filter by version so we get all messages regardless of passphrase rotation
      const { messages: historyMessages } = await getHistory(currentRoomId, {
        limit: 50,
      });

      const decrypted = await Promise.all(
        historyMessages.map(async (msg) => {
          return decryptMessage(msg, currentRoomId, key);
        })
      );

      setMessages(decrypted);

      // Only update cache if we got results (don't overwrite good cache with empty)
      if (decrypted.length > 0) {
        setCachedMessages(currentRoomId, decrypted.map((m) => ({
          msgId: m.msgId,
          displayName: m.displayName,
          text: m.text,
          clientTs: m.clientTs,
          createdAt: m.createdAt,
        })));
      }
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  };

  // Decrypt a single message
  const decryptMessage = async (
    msg: HistoryMessage,
    currentRoomId: string,
    key: CryptoKey
  ): Promise<DecryptedMessage> => {
    try {
      const payload = await decryptPayload(
        key,
        currentRoomId,
        msg.version,
        msg.msgId,
        msg.ivB64,
        msg.ciphertextB64
      );

      const trustStatus = await verifyAndCheckTrust(payload, msg.msgId, currentRoomId);

      return {
        msgId: msg.msgId,
        displayName: payload.displayName,
        text: payload.text,
        clientTs: payload.clientTs,
        createdAt: msg.createdAt,
        isOwn: false,
        trustStatus,
      };
    } catch {
      return {
        msgId: msg.msgId,
        displayName: '???',
        text: '[Unable to decrypt]',
        clientTs: 0,
        createdAt: msg.createdAt,
        isOwn: false,
        error: true,
        trustStatus: 'unsigned',
      };
    }
  };

  // Connect WebSocket
  useEffect(() => {
    if (!room || !cryptoKey || !displayName || showNameModal) return;

    const connect = () => {
      setConnectionStatus('connecting');
      const ws = new WebSocket(getWebSocketUrl(room.roomId));
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus('connected');
      };

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'error') {
            console.error('WebSocket error:', data.message);
            if (data.code === 'name_taken') {
              setError(data.message);
              // Force name change — clear stored name and reopen modal
              if (roomId) {
                localStorage.removeItem(`displayName:${roomId}`);
              }
              setDisplayName('');
              setSigningActive(false);
              signingKeyRef.current = null;
              setShowNameModal(true);
            }
            return;
          }

          if (data.type === 'message') {
            // Don't add if we already have this message
            setMessages((prev) => {
              if (prev.some((m) => m.msgId === data.msgId)) {
                return prev;
              }

              // Decrypt asynchronously and update
              decryptMessage(data, room.roomId, cryptoKey).then((decrypted) => {
                setMessages((current) => {
                  // Check again in case it was added while decrypting
                  if (current.some((m) => m.msgId === data.msgId)) {
                    return current;
                  }
                  // Cache the new message
                  appendCachedMessage(room.roomId, {
                    msgId: decrypted.msgId,
                    displayName: decrypted.displayName,
                    text: decrypted.text,
                    clientTs: decrypted.clientTs,
                    createdAt: decrypted.createdAt,
                  });
                  return [...current, decrypted];
                });
              });

              return prev;
            });
          }
        } catch (err) {
          console.error('Failed to process message:', err);
        }
      };

      ws.onclose = () => {
        setConnectionStatus('disconnected');
        // Reconnect after delay
        setTimeout(() => {
          if (wsRef.current === ws) {
            connect();
          }
        }, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [room, cryptoKey, displayName, showNameModal]);

  // Send message
  const sendMessage = async (e: FormEvent) => {
    e.preventDefault();

    const text = messageInput.trim();
    if (!text || !room || !cryptoKey || !wsRef.current) return;

    const msgId = generateMsgId();
    const clientTs = Date.now();

    const payload: MessagePayload = {
      text,
      displayName,
      clientTs,
    };

    // Sign the message if we have a signing key
    if (signingKeyRef.current) {
      payload.signatureB64 = await signMessage(
        signingKeyRef.current.privateKey,
        text,
        displayName,
        clientTs,
        msgId
      );
      payload.senderPublicKeyJwk = signingKeyRef.current.publicKeyJwk;
    }

    try {
      const { ivB64, ciphertextB64 } = await encryptPayload(
        cryptoKey,
        room.roomId,
        room.version,
        msgId,
        payload
      );

      // Send via WebSocket (include senderName + keyFingerprint for server-side name claim)
      wsRef.current.send(
        JSON.stringify({
          type: 'message',
          msgId,
          version: room.version,
          ivB64,
          ciphertextB64,
          clientTs,
          senderName: displayName,
          keyFingerprint: signingKeyRef.current?.fingerprint,
        })
      );

      const createdAt = new Date().toISOString();

      // Optimistically add to local messages
      setMessages((prev) => [
        ...prev,
        {
          msgId,
          displayName,
          text,
          clientTs,
          createdAt,
          isOwn: true,
          trustStatus: signingKeyRef.current ? 'verified' : 'unsigned',
        },
      ]);

      // Cache sent message
      appendCachedMessage(room.roomId, {
        msgId,
        displayName,
        text,
        clientTs,
        createdAt,
      });

      setMessageInput('');
    } catch (err) {
      console.error('Failed to send message:', err);
    }
  };

  // Set display name
  const handleSetDisplayName = (e: FormEvent) => {
    e.preventDefault();
    const name = displayName.trim();
    if (!name || !roomId) return;

    localStorage.setItem(`displayName:${roomId}`, name);
    setDisplayName(name);
    setShowNameModal(false);
  };

  // Format timestamp
  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  if (loading) {
    return (
      <div className="home">
        <div className="home-content">
          <p>Opening recipe...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="home">
        <div className="home-content">
          <p className="error-message">{error}</p>
          <button onClick={() => navigate('/')} style={{ marginTop: '1rem' }}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="room">
      {/* Display name modal */}
      {showNameModal && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>What should we call you?</h2>
            <p>This name will be shown to others in this recipe.</p>
            <form onSubmit={handleSetDisplayName}>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Display name"
                autoFocus
                maxLength={50}
              />
              <button type="submit" disabled={!displayName.trim()}>
                Continue
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="room-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <Link to="/" className="room-back" title="Switch recipe">
            &larr;
          </Link>
          <div>
            <div className="room-title">{room?.title || 'Untitled Recipe'}</div>
            <div className="room-code">{roomId}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.2rem', marginLeft: 'auto' }}>
            <span
              className={`connection-status ${connectionStatus}`}
              title={connectionStatus}
            >
              {connectionStatus === 'connected'
                ? 'connected'
                : connectionStatus === 'connecting'
                ? 'connecting...'
                : 'disconnected'}
            </span>
            {signingActive && (
              <span className="signing-status" title="Messages are signed with your identity key">
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: '0.25rem' }}>
                  <path d="M6 1C4.34 1 3 2.34 3 4V5H2.5C2.22 5 2 5.22 2 5.5V10.5C2 10.78 2.22 11 2.5 11H9.5C9.78 11 10 10.78 10 10.5V5.5C10 5.22 9.78 5 9.5 5H9V4C9 2.34 7.66 1 6 1ZM7.5 5H4.5V4C4.5 3.17 5.17 2.5 6 2.5C6.83 2.5 7.5 3.17 7.5 4V5Z" fill="currentColor"/>
                </svg>
                signed
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="messages-container">
        {messages.map((msg) => (
          <div
            key={msg.msgId}
            className={`message ${msg.isOwn ? 'own' : ''}`}
          >
            <div className="message-sender">
              {!msg.isOwn && msg.displayName}
              <TrustIndicator status={msg.trustStatus} />
            </div>
            <div className={`message-text ${msg.error ? 'message-error' : ''}`}>
              {msg.text}
            </div>
            <div className="message-time">{formatTime(msg.createdAt)}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Message input */}
      <div className="message-input-container">
        <form className="message-input-form" onSubmit={sendMessage}>
          <input
            type="text"
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            placeholder="Type a message..."
            disabled={connectionStatus !== 'connected'}
          />
          <button
            type="submit"
            disabled={!messageInput.trim() || connectionStatus !== 'connected'}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
