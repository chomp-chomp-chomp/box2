import { useState, useEffect, useRef, useCallback, FormEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getRoom, getHistory, getWebSocketUrl, RoomInfo, HistoryMessage } from '../utils/api';
import { saveRecentRoom } from '../utils/recentRooms';
import { getCachedMessages, setCachedMessages, appendCachedMessage, removeCachedMessage } from '../utils/messageCache';
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

interface QueuedMessage {
  msgId: string;
  version: number;
  ivB64: string;
  ciphertextB64: string;
  senderName: string;
  keyFingerprint: string;
  displayName: string;
  text: string;
  clientTs: number;
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

function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') || fp;
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
  const [peerCount, setPeerCount] = useState(0);
  const [onlineMembers, setOnlineMembers] = useState<string[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [showKeyInfo, setShowKeyInfo] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [signingActive, setSigningActive] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const signingKeyRef = useRef<{ privateKey: CryptoKey; publicKeyJwk: JsonWebKey; fingerprint: string } | null>(null);
  const sendQueueRef = useRef<QueuedMessage[]>([]);
  const lastTypingSentRef = useRef(0);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
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
          privateKey = await crypto.subtle.importKey(
            'jwk',
            stored.privateKeyJwk,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['sign']
          );
          publicKeyJwk = stored.publicKeyJwk;
        } else {
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

      const stored = localStorage.getItem(`recipe:${roomId}`) || sessionStorage.getItem(`recipe:${roomId}`);
      if (!stored) {
        navigate('/');
        return;
      }

      if (!localStorage.getItem(`recipe:${roomId}`) && sessionStorage.getItem(`recipe:${roomId}`)) {
        localStorage.setItem(`recipe:${roomId}`, stored);
      }

      const { passphrase: storedPassphrase } = JSON.parse(stored);

      const storedName = localStorage.getItem(`displayName:${roomId}`);
      if (storedName) {
        setDisplayName(storedName);
      } else {
        setShowNameModal(true);
      }

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
        const roomInfo = await getRoom(roomId);
        setRoom(roomInfo);
        saveRecentRoom(roomId, roomInfo.title || 'Untitled Recipe');

        const key = await deriveKeyPBKDF2(
          storedPassphrase,
          roomInfo.saltB64,
          roomInfo.kdfIters
        );
        setCryptoKey(key);
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
    if (!payload.signatureB64 || !payload.senderPublicKeyJwk) {
      return 'unsigned';
    }

    try {
      const senderKey = await importPublicKeyJwk(payload.senderPublicKeyJwk);
      const valid = await verifySignature(
        senderKey,
        payload.signatureB64,
        payload.text,
        payload.displayName,
        payload.clientTs,
        msgId
      );

      if (!valid) return 'mismatch';

      const trusted = await getTrustedKey(currentRoomId, payload.displayName);

      if (!trusted) {
        await saveTrustedKey(currentRoomId, payload.displayName, payload.senderPublicKeyJwk);
        return 'new';
      }

      if (jwkEqual(trusted.publicKeyJwk, payload.senderPublicKeyJwk)) {
        return 'verified';
      }

      return 'mismatch';
    } catch (err) {
      console.error('Signature verification failed:', err);
      return 'mismatch';
    }
  };

  // Load message history
  const loadHistory = async (currentRoomId: string, key: CryptoKey) => {
    try {
      const { messages: historyMessages } = await getHistory(currentRoomId, { limit: 50 });

      const decrypted = await Promise.all(
        historyMessages.map(async (msg) => decryptMessage(msg, currentRoomId, key))
      );

      // Only update messages and cache if we got results (don't overwrite cache with empty)
      if (decrypted.length > 0) {
        setMessages(decrypted);
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
      // Keep showing cached messages on error - don't clear them
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
        key, currentRoomId, msg.version, msg.msgId, msg.ivB64, msg.ciphertextB64
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

  // Flush offline send queue
  const flushSendQueue = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;

    const queue = sendQueueRef.current;
    sendQueueRef.current = [];

    for (const item of queue) {
      ws.send(JSON.stringify({
        type: 'message',
        msgId: item.msgId,
        version: item.version,
        ivB64: item.ivB64,
        ciphertextB64: item.ciphertextB64,
        senderName: item.senderName,
        keyFingerprint: item.keyFingerprint,
      }));
    }
  }, []);

  // Connect WebSocket
  useEffect(() => {
    if (!room || !cryptoKey || !displayName || showNameModal) return;

    const connect = () => {
      setConnectionStatus('connecting');
      const ws = new WebSocket(getWebSocketUrl(room.roomId));
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus('connected');
        // Announce our display name for presence
        ws.send(JSON.stringify({ type: 'presence', displayName }));
        // Flush any queued messages
        flushSendQueue();
      };

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'connected') {
            setPeerCount(data.connectionCount || 0);
            if (data.members) setOnlineMembers(data.members);
            return;
          }

          if (data.type === 'peer_count') {
            setPeerCount(data.connectionCount || 0);
            return;
          }

          if (data.type === 'presence') {
            if (data.members) setOnlineMembers(data.members);
            setPeerCount(data.connectionCount || 0);
            return;
          }

          if (data.type === 'typing') {
            if (data.displayName && data.displayName !== displayName) {
              setTypingUsers((prev) => {
                const next = new Set(prev);
                next.add(data.displayName);
                return next;
              });
              // Clear after 3s
              setTimeout(() => {
                setTypingUsers((prev) => {
                  const next = new Set(prev);
                  next.delete(data.displayName);
                  return next;
                });
              }, 3000);
            }
            return;
          }

          if (data.type === 'delete') {
            setMessages((current) => current.filter((m) => m.msgId !== data.msgId));
            if (roomId) removeCachedMessage(roomId, data.msgId);
            return;
          }

          if (data.type === 'error') {
            console.error('WebSocket error:', data.message);
            if (data.code === 'name_taken') {
              setError(data.message);
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
            try {
              const decrypted = await decryptMessage(data, room.roomId, cryptoKey);
              setMessages((current) => {
                if (current.some((m) => m.msgId === data.msgId)) {
                  return current;
                }
                appendCachedMessage(room.roomId, {
                  msgId: decrypted.msgId,
                  displayName: decrypted.displayName,
                  text: decrypted.text,
                  clientTs: decrypted.clientTs,
                  createdAt: decrypted.createdAt,
                });
                return [...current, decrypted];
              });
            } catch (err) {
              console.error('Failed to decrypt incoming message:', err);
            }
          }
        } catch (err) {
          console.error('Failed to process message:', err);
        }
      };

      ws.onclose = () => {
        setConnectionStatus('disconnected');
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
  }, [room, cryptoKey, displayName, showNameModal, flushSendQueue]);

  // Send typing indicator (throttled to once per 2s)
  const sendTypingIndicator = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2000) return;
    lastTypingSentRef.current = now;
    ws.send(JSON.stringify({ type: 'typing', displayName }));
  }, [displayName]);

  // Handle input change with typing indicator
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMessageInput(e.target.value);
    if (e.target.value.trim()) {
      sendTypingIndicator();
    }
  };

  // Send message (or queue if offline)
  const sendMessage = async (e: FormEvent) => {
    e.preventDefault();

    const text = messageInput.trim();
    if (!text || !room || !cryptoKey || !signingKeyRef.current) return;

    const msgId = generateMsgId();
    const clientTs = Date.now();

    const payload: MessagePayload = {
      text,
      displayName,
      clientTs,
    };

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
        cryptoKey, room.roomId, room.version, msgId, payload
      );

      const wsPayload = {
        type: 'message',
        msgId,
        version: room.version,
        ivB64,
        ciphertextB64,
        senderName: displayName,
        keyFingerprint: signingKeyRef.current?.fingerprint,
      };

      const ws = wsRef.current;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(wsPayload));
      } else {
        // Queue for later
        sendQueueRef.current.push({
          msgId,
          version: room.version,
          ivB64,
          ciphertextB64,
          senderName: displayName,
          keyFingerprint: signingKeyRef.current?.fingerprint || '',
          displayName,
          text,
          clientTs,
        });
      }

      const createdAt = new Date().toISOString();

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

      appendCachedMessage(room.roomId, {
        msgId, displayName, text, clientTs, createdAt,
      });

      setMessageInput('');
    } catch (err) {
      console.error('Failed to send message:', err);
    }
  };

  // Delete a message
  const deleteMessage = (msgId: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'delete', msgId, senderName: displayName }));
    }
    setMessages((current) => current.filter((m) => m.msgId !== msgId));
    if (roomId) removeCachedMessage(roomId, msgId);
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

  // Typing indicator text
  const typingText = (() => {
    const users = Array.from(typingUsers);
    if (users.length === 0) return null;
    if (users.length === 1) return `${users[0]} is typing...`;
    if (users.length === 2) return `${users[0]} and ${users[1]} are typing...`;
    return `${users[0]} and ${users.length - 1} others are typing...`;
  })();

  // Queued message count
  const queueCount = sendQueueRef.current.length;

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

      {/* Key info modal */}
      {showKeyInfo && (
        <div className="modal-overlay" onClick={() => setShowKeyInfo(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Your identity key</h2>
            <p>Share this fingerprint out-of-band to verify your identity with others.</p>
            <div className="key-fingerprint">
              <div className="key-fingerprint-label">Your fingerprint</div>
              <div className="key-fingerprint-value">
                {signingKeyRef.current ? formatFingerprint(signingKeyRef.current.fingerprint) : 'Not available'}
              </div>
              <div className="key-fingerprint-name">{displayName}</div>
            </div>
            <div style={{ marginTop: 'var(--spacing-lg)' }}>
              <button className="secondary" onClick={() => setShowKeyInfo(false)} style={{ width: '100%' }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Members panel */}
      {showMembers && (
        <div className="modal-overlay" onClick={() => setShowMembers(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Online members</h2>
            <div className="members-list">
              {onlineMembers.length === 0 ? (
                <p className="empty-members">No members online</p>
              ) : (
                onlineMembers.map((name) => (
                  <div key={name} className="member-item">
                    <span className="member-dot" />
                    <span className="member-name">{name}</span>
                    {name === displayName && <span className="member-you">(you)</span>}
                  </div>
                ))
              )}
            </div>
            <div style={{ marginTop: 'var(--spacing-lg)' }}>
              <button className="secondary" onClick={() => setShowMembers(false)} style={{ width: '100%' }}>
                Close
              </button>
            </div>
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
            <button
              className="header-btn"
              onClick={() => setShowMembers(true)}
              title="View online members"
            >
              {connectionStatus === 'connected'
                ? `${peerCount} online`
                : connectionStatus === 'connecting'
                ? 'connecting...'
                : 'disconnected'}
            </button>
            {signingActive && (
              <button
                className="header-btn signing-status"
                onClick={() => setShowKeyInfo(true)}
                title="View your identity key"
              >
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: '0.25rem' }}>
                  <path d="M6 1C4.34 1 3 2.34 3 4V5H2.5C2.22 5 2 5.22 2 5.5V10.5C2 10.78 2.22 11 2.5 11H9.5C9.78 11 10 10.78 10 10.5V5.5C10 5.22 9.78 5 9.5 5H9V4C9 2.34 7.66 1 6 1ZM7.5 5H4.5V4C4.5 3.17 5.17 2.5 6 2.5C6.83 2.5 7.5 3.17 7.5 4V5Z" fill="currentColor"/>
                </svg>
                signed
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="messages-container" ref={messagesContainerRef}>
        {messages.map((msg) => (
          <div
            key={msg.msgId}
            className={`message ${msg.isOwn ? 'own' : ''}`}
          >
            <div className="message-sender">
              {!msg.isOwn && msg.displayName}
              <TrustIndicator status={msg.trustStatus} />
              {msg.isOwn && (
                <button
                  className="message-delete"
                  onClick={() => deleteMessage(msg.msgId)}
                  title="Delete message"
                >
                  &times;
                </button>
              )}
            </div>
            <div className={`message-text ${msg.error ? 'message-error' : ''}`}>
              {msg.text}
            </div>
            <div className="message-time">{formatTime(msg.createdAt)}</div>
          </div>
        ))}
        {typingText && (
          <div className="typing-indicator">{typingText}</div>
        )}
      </div>

      {/* Message input */}
      <div className="message-input-container">
        {queueCount > 0 && (
          <div className="queue-indicator">
            {queueCount} message{queueCount > 1 ? 's' : ''} queued — will send when reconnected
          </div>
        )}
        <form className="message-input-form" onSubmit={sendMessage}>
          <input
            type="text"
            value={messageInput}
            onChange={handleInputChange}
            placeholder="Type a message..."
            disabled={!signingActive}
          />
          <button
            type="submit"
            disabled={!messageInput.trim() || !signingActive}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
