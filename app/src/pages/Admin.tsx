import { useState, useEffect, useCallback, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { createRoom, rotatePassphrase, listRooms, deleteRoom, AdminRoom } from '../utils/api';
import { generatePassphrase } from '../utils/crypto';

interface InviteKit {
  roomId: string;
  title: string | null;
  passphrase: string;
  shareLink: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/['']/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function Admin() {
  // Admin token state
  const [adminToken, setAdminToken] = useState(() => {
    return localStorage.getItem('adminToken') || '';
  });
  const [tokenInput, setTokenInput] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return !!localStorage.getItem('adminToken');
  });

  // Create recipe state
  const [createName, setCreateName] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createInviteKit, setCreateInviteKit] = useState<InviteKit | null>(null);

  // Rotate passphrase state
  const [rotateRoomId, setRotateRoomId] = useState('');
  const [rotateLoading, setRotateLoading] = useState(false);
  const [rotateError, setRotateError] = useState('');
  const [rotateInviteKit, setRotateInviteKit] = useState<InviteKit | null>(null);

  // Room list state
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Set admin token
  const handleSetToken = (e: FormEvent) => {
    e.preventDefault();
    const token = tokenInput.trim();
    if (!token) return;

    localStorage.setItem('adminToken', token);
    setAdminToken(token);
    setIsAuthenticated(true);
    setTokenInput('');
  };

  // Logout
  const handleLogout = () => {
    localStorage.removeItem('adminToken');
    setAdminToken('');
    setIsAuthenticated(false);
  };

  // Create recipe
  const handleCreateRecipe = async (e: FormEvent) => {
    e.preventDefault();
    setCreateError('');
    setCreateInviteKit(null);
    setCreateLoading(true);

    const name = createName.trim();
    if (!name) {
      setCreateError('Please enter a recipe name.');
      setCreateLoading(false);
      return;
    }

    const slug = slugify(name);
    if (slug.length < 3) {
      setCreateError('Recipe name must be at least 3 characters.');
      setCreateLoading(false);
      return;
    }

    try {
      // Create room with slug as ID and original name as title
      const room = await createRoom(adminToken, {
        slug,
        title: name,
      });

      // Generate passphrase client-side
      const passphrase = generatePassphrase();

      // Build share link with passphrase in fragment (never sent to server)
      const shareLink = `${window.location.origin}/join/${encodeURIComponent(room.roomId)}#${passphrase}`;

      // Show invite kit
      setCreateInviteKit({
        roomId: room.roomId,
        title: room.title,
        passphrase,
        shareLink,
      });

      // Clear form and refresh list
      setCreateName('');
      loadRooms();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create recipe');
    } finally {
      setCreateLoading(false);
    }
  };

  // Rotate passphrase
  const handleRotatePassphrase = async (e: FormEvent) => {
    e.preventDefault();
    setRotateError('');
    setRotateInviteKit(null);
    setRotateLoading(true);

    const roomId = rotateRoomId.trim();
    if (!roomId) {
      setRotateError('Please enter a recipe name');
      setRotateLoading(false);
      return;
    }

    try {
      // Rotate on server
      const room = await rotatePassphrase(adminToken, roomId);

      // Generate new passphrase client-side
      const passphrase = generatePassphrase();

      // Build share link
      const shareLink = `${window.location.origin}/join/${encodeURIComponent(room.roomId)}#${passphrase}`;

      // Show invite kit
      setRotateInviteKit({
        roomId: room.roomId,
        title: null,
        passphrase,
        shareLink,
      });

      // Clear form
      setRotateRoomId('');
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : 'Failed to rotate passphrase');
    } finally {
      setRotateLoading(false);
    }
  };

  // Load rooms
  const loadRooms = useCallback(async () => {
    if (!adminToken) return;
    setRoomsLoading(true);
    setRoomsError('');
    try {
      const { rooms: roomList } = await listRooms(adminToken);
      setRooms(roomList);
    } catch (err) {
      setRoomsError(err instanceof Error ? err.message : 'Failed to load rooms');
    } finally {
      setRoomsLoading(false);
    }
  }, [adminToken]);

  // Load rooms on auth
  useEffect(() => {
    if (isAuthenticated) {
      loadRooms();
    }
  }, [isAuthenticated, loadRooms]);

  // Delete room
  const handleDeleteRoom = async (roomId: string) => {
    try {
      await deleteRoom(adminToken, roomId);
      setRooms((prev) => prev.filter((r) => r.roomId !== roomId));
      setDeleteConfirm(null);
    } catch (err) {
      setRoomsError(err instanceof Error ? err.message : 'Failed to delete room');
    }
  };

  // Copy feedback state
  const [copied, setCopied] = useState<string | null>(null);

  // Copy to clipboard
  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  if (!isAuthenticated) {
    return (
      <div className="admin">
        <h1>Admin</h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          Enter your admin token to continue.
        </p>

        <form className="admin-form" onSubmit={handleSetToken}>
          <div>
            <label htmlFor="token">Admin Token</label>
            <input
              id="token"
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Paste admin token"
              autoComplete="off"
            />
          </div>
          <button type="submit" disabled={!tokenInput.trim()}>
            Continue
          </button>
        </form>

        <Link to="/" className="nav-link" style={{ display: 'block', marginTop: '2rem' }}>
          Back to kitchen
        </Link>
      </div>
    );
  }

  return (
    <div className="admin">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>Admin</h1>
        <button className="secondary small" onClick={handleLogout}>
          Logout
        </button>
      </div>

      {/* Create Recipe Section */}
      <div className="admin-section">
        <h2>Create Recipe</h2>
        <form className="admin-form" onSubmit={handleCreateRecipe}>
          <div>
            <label htmlFor="create-name">Recipe Name</label>
            <input
              id="create-name"
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="e.g., grandma's cookies"
              maxLength={64}
            />
            {createName.trim() && (
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                URL: {slugify(createName.trim())}
              </div>
            )}
          </div>
          <button type="submit" disabled={createLoading || !createName.trim()}>
            {createLoading ? 'Creating...' : 'Create Recipe'}
          </button>
          {createError && <div className="error-message">{createError}</div>}
        </form>

        {createInviteKit && (
          <div className="invite-kit">
            <h3>Share Link</h3>
            <div className="invite-kit-item">
              <div className="invite-kit-label">Send this link to invite people</div>
              <div className="invite-kit-value" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <code style={{ fontSize: '0.7rem', wordBreak: 'break-all' }}>{createInviteKit.shareLink}</code>
                <button
                  className="secondary small"
                  style={{ alignSelf: 'flex-start', marginTop: '0.5rem' }}
                  onClick={() => copyToClipboard(createInviteKit.shareLink, 'create-link')}
                >
                  {copied === 'create-link' ? 'Copied!' : 'Copy Link'}
                </button>
              </div>
            </div>
            <details style={{ marginTop: '0.75rem' }}>
              <summary style={{ fontSize: '0.8rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                Manual entry details
              </summary>
              <div style={{ marginTop: '0.5rem' }}>
                <div className="invite-kit-item">
                  <div className="invite-kit-label">Recipe Name</div>
                  <div className="invite-kit-value">
                    <code>{createInviteKit.roomId}</code>
                    <button
                      className="secondary small"
                      onClick={() => copyToClipboard(createInviteKit.roomId, 'create-code')}
                    >
                      {copied === 'create-code' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
                <div className="invite-kit-item">
                  <div className="invite-kit-label">Passphrase</div>
                  <div className="invite-kit-value">
                    <code>{createInviteKit.passphrase}</code>
                    <button
                      className="secondary small"
                      onClick={() => copyToClipboard(createInviteKit.passphrase, 'create-pass')}
                    >
                      {copied === 'create-pass' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              </div>
            </details>
            <p className="invite-kit-warning">
              Save this link or passphrase now. It will not be shown again.
            </p>
          </div>
        )}
      </div>

      {/* Rotate Passphrase Section */}
      <div className="admin-section">
        <h2>Rotate Passphrase</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>
          Generate a new passphrase for an existing recipe. Previous messages will remain encrypted with the old key.
        </p>
        <form className="admin-form" onSubmit={handleRotatePassphrase}>
          <div>
            <label htmlFor="rotate-room">Recipe Name</label>
            <input
              id="rotate-room"
              type="text"
              value={rotateRoomId}
              onChange={(e) => setRotateRoomId(e.target.value)}
              placeholder="e.g. grandmas-cookies"
              autoComplete="off"
            />
          </div>
          <button type="submit" disabled={rotateLoading || !rotateRoomId.trim()}>
            {rotateLoading ? 'Rotating...' : 'Rotate Passphrase'}
          </button>
          {rotateError && <div className="error-message">{rotateError}</div>}
        </form>

        {rotateInviteKit && (
          <div className="invite-kit">
            <h3>New Share Link</h3>
            <div className="invite-kit-item">
              <div className="invite-kit-label">Send this link to invite people</div>
              <div className="invite-kit-value" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <code style={{ fontSize: '0.7rem', wordBreak: 'break-all' }}>{rotateInviteKit.shareLink}</code>
                <button
                  className="secondary small"
                  style={{ alignSelf: 'flex-start', marginTop: '0.5rem' }}
                  onClick={() => copyToClipboard(rotateInviteKit.shareLink, 'rotate-link')}
                >
                  {copied === 'rotate-link' ? 'Copied!' : 'Copy Link'}
                </button>
              </div>
            </div>
            <details style={{ marginTop: '0.75rem' }}>
              <summary style={{ fontSize: '0.8rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                Manual entry details
              </summary>
              <div style={{ marginTop: '0.5rem' }}>
                <div className="invite-kit-item">
                  <div className="invite-kit-label">Recipe Name</div>
                  <div className="invite-kit-value">
                    <code>{rotateInviteKit.roomId}</code>
                    <button
                      className="secondary small"
                      onClick={() => copyToClipboard(rotateInviteKit.roomId, 'rotate-code')}
                    >
                      {copied === 'rotate-code' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
                <div className="invite-kit-item">
                  <div className="invite-kit-label">New Passphrase</div>
                  <div className="invite-kit-value">
                    <code>{rotateInviteKit.passphrase}</code>
                    <button
                      className="secondary small"
                      onClick={() => copyToClipboard(rotateInviteKit.passphrase, 'rotate-pass')}
                    >
                      {copied === 'rotate-pass' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              </div>
            </details>
            <p className="invite-kit-warning">
              Save this link or passphrase now. It will not be shown again. Share it with participants.
            </p>
          </div>
        )}
      </div>

      {/* All Rooms Section */}
      <div className="admin-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>All Rooms</h2>
          <button className="secondary small" onClick={loadRooms} disabled={roomsLoading}>
            {roomsLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
        {roomsError && <div className="error-message">{roomsError}</div>}

        {rooms.length === 0 && !roomsLoading && !roomsError && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No rooms yet.</p>
        )}

        {rooms.length > 0 && (
          <div className="rooms-list">
            {rooms.map((room) => (
              <div key={room.roomId} className="room-list-item">
                <div className="room-list-info">
                  <div className="room-list-title">{room.title || 'Untitled'}</div>
                  <div className="room-list-meta">
                    <code>{room.roomId}</code>
                    <span>{room.messageCount} messages</span>
                    <span>v{room.version}</span>
                    <span>{new Date(room.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="room-list-actions">
                  {deleteConfirm === room.roomId ? (
                    <>
                      <button
                        className="danger small"
                        onClick={() => handleDeleteRoom(room.roomId)}
                      >
                        Confirm
                      </button>
                      <button
                        className="secondary small"
                        onClick={() => setDeleteConfirm(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      className="secondary small"
                      onClick={() => setDeleteConfirm(room.roomId)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Link to="/" className="nav-link" style={{ display: 'block', marginTop: '1rem' }}>
        Back to kitchen
      </Link>
    </div>
  );
}
