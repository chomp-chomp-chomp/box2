import { useState, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { createRoom, rotatePassphrase } from '../utils/api';
import { generatePassphrase } from '../utils/crypto';

interface InviteKit {
  roomId: string;
  title: string | null;
  passphrase: string;
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
  const [createTitle, setCreateTitle] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createInviteKit, setCreateInviteKit] = useState<InviteKit | null>(null);

  // Rotate passphrase state
  const [rotateRoomId, setRotateRoomId] = useState('');
  const [rotateLoading, setRotateLoading] = useState(false);
  const [rotateError, setRotateError] = useState('');
  const [rotateInviteKit, setRotateInviteKit] = useState<InviteKit | null>(null);

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

    try {
      // Create room on server
      const room = await createRoom(adminToken, {
        title: createTitle.trim() || undefined,
      });

      // Generate passphrase client-side
      const passphrase = generatePassphrase();

      // Show invite kit
      setCreateInviteKit({
        roomId: room.roomId,
        title: room.title,
        passphrase,
      });

      // Clear form
      setCreateTitle('');
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
      setRotateError('Please enter a recipe code');
      setRotateLoading(false);
      return;
    }

    try {
      // Rotate on server
      const room = await rotatePassphrase(adminToken, roomId);

      // Generate new passphrase client-side
      const passphrase = generatePassphrase();

      // Show invite kit
      setRotateInviteKit({
        roomId: room.roomId,
        title: null,
        passphrase,
      });

      // Clear form
      setRotateRoomId('');
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : 'Failed to rotate passphrase');
    } finally {
      setRotateLoading(false);
    }
  };

  // Copy to clipboard
  const copyToClipboard = async (text: string) => {
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
            <label htmlFor="create-title">Recipe Title (optional)</label>
            <input
              id="create-title"
              type="text"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="e.g., Team Chat"
              maxLength={100}
            />
          </div>
          <button type="submit" disabled={createLoading}>
            {createLoading ? 'Creating...' : 'Create Recipe'}
          </button>
          {createError && <div className="error-message">{createError}</div>}
        </form>

        {createInviteKit && (
          <div className="invite-kit">
            <h3>Invite Kit</h3>
            {createInviteKit.title && (
              <div className="invite-kit-item">
                <div className="invite-kit-label">Title</div>
                <div className="invite-kit-value">
                  <code>{createInviteKit.title}</code>
                </div>
              </div>
            )}
            <div className="invite-kit-item">
              <div className="invite-kit-label">Recipe Code</div>
              <div className="invite-kit-value">
                <code>{createInviteKit.roomId}</code>
                <button
                  className="secondary small"
                  onClick={() => copyToClipboard(createInviteKit.roomId)}
                >
                  Copy
                </button>
              </div>
            </div>
            <div className="invite-kit-item">
              <div className="invite-kit-label">Passphrase</div>
              <div className="invite-kit-value">
                <code>{createInviteKit.passphrase}</code>
                <button
                  className="secondary small"
                  onClick={() => copyToClipboard(createInviteKit.passphrase)}
                >
                  Copy
                </button>
              </div>
            </div>
            <p className="invite-kit-warning">
              Save this passphrase now. It will not be shown again.
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
            <label htmlFor="rotate-room">Recipe Code</label>
            <input
              id="rotate-room"
              type="text"
              value={rotateRoomId}
              onChange={(e) => setRotateRoomId(e.target.value)}
              placeholder="Enter recipe code"
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
            <h3>New Invite Kit</h3>
            <div className="invite-kit-item">
              <div className="invite-kit-label">Recipe Code</div>
              <div className="invite-kit-value">
                <code>{rotateInviteKit.roomId}</code>
                <button
                  className="secondary small"
                  onClick={() => copyToClipboard(rotateInviteKit.roomId)}
                >
                  Copy
                </button>
              </div>
            </div>
            <div className="invite-kit-item">
              <div className="invite-kit-label">New Passphrase</div>
              <div className="invite-kit-value">
                <code>{rotateInviteKit.passphrase}</code>
                <button
                  className="secondary small"
                  onClick={() => copyToClipboard(rotateInviteKit.passphrase)}
                >
                  Copy
                </button>
              </div>
            </div>
            <p className="invite-kit-warning">
              Save this passphrase now. It will not be shown again. Share it with participants.
            </p>
          </div>
        )}
      </div>

      <Link to="/" className="nav-link" style={{ display: 'block', marginTop: '1rem' }}>
        Back to kitchen
      </Link>
    </div>
  );
}
