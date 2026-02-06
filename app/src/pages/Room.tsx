import { useState, useEffect, useRef, FormEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getRoom, getHistory, getWebSocketUrl, RoomInfo, HistoryMessage } from '../utils/api';
import { saveRecentRoom } from '../utils/recentRooms';
import {
  deriveKeyPBKDF2,
  encryptPayload,
  decryptPayload,
  generateMsgId,
  MessagePayload,
} from '../utils/crypto';

interface DecryptedMessage {
  msgId: string;
  displayName: string;
  text: string;
  clientTs: number;
  createdAt: string;
  isOwn: boolean;
  error?: boolean;
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

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Load room and credentials
  useEffect(() => {
    const loadRoom = async () => {
      if (!roomId) {
        navigate('/');
        return;
      }

      // Get stored credentials
      const stored = sessionStorage.getItem(`recipe:${roomId}`);
      if (!stored) {
        navigate('/');
        return;
      }

      const { passphrase: storedPassphrase } = JSON.parse(stored);

      // Get stored display name
      const storedName = localStorage.getItem(`displayName:${roomId}`);
      if (storedName) {
        setDisplayName(storedName);
      } else {
        setShowNameModal(true);
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

        // Load history
        await loadHistory(roomId, roomInfo, key);

        setLoading(false);
      } catch (err) {
        console.error('Failed to load room:', err);
        setError("Couldn't open this recipe.");
        setLoading(false);
      }
    };

    loadRoom();
  }, [roomId, navigate]);

  // Load message history
  const loadHistory = async (
    roomId: string,
    roomInfo: RoomInfo,
    key: CryptoKey
  ) => {
    try {
      const { messages: historyMessages } = await getHistory(roomId, {
        limit: 50,
        version: roomInfo.version,
      });

      const decrypted = await Promise.all(
        historyMessages.map(async (msg) => {
          return decryptMessage(msg, roomId, key);
        })
      );

      setMessages(decrypted);
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  };

  // Decrypt a single message
  const decryptMessage = async (
    msg: HistoryMessage,
    roomId: string,
    key: CryptoKey
  ): Promise<DecryptedMessage> => {
    try {
      const payload = await decryptPayload(
        key,
        roomId,
        msg.version,
        msg.msgId,
        msg.ivB64,
        msg.ciphertextB64
      );

      return {
        msgId: msg.msgId,
        displayName: payload.displayName,
        text: payload.text,
        clientTs: payload.clientTs,
        createdAt: msg.createdAt,
        isOwn: false, // Will be updated for own messages
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

    try {
      const { ivB64, ciphertextB64 } = await encryptPayload(
        cryptoKey,
        room.roomId,
        room.version,
        msgId,
        payload
      );

      // Send via WebSocket
      wsRef.current.send(
        JSON.stringify({
          type: 'message',
          msgId,
          version: room.version,
          ivB64,
          ciphertextB64,
          clientTs,
        })
      );

      // Optimistically add to local messages
      setMessages((prev) => [
        ...prev,
        {
          msgId,
          displayName,
          text,
          clientTs,
          createdAt: new Date().toISOString(),
          isOwn: true,
        },
      ]);

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
        </div>
      </div>

      {/* Messages */}
      <div className="messages-container">
        {messages.map((msg) => (
          <div
            key={msg.msgId}
            className={`message ${msg.isOwn ? 'own' : ''}`}
          >
            {!msg.isOwn && (
              <div className="message-sender">{msg.displayName}</div>
            )}
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
