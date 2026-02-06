import { useState, useEffect, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRoom } from '../utils/api';
import { deriveKeyPBKDF2 } from '../utils/crypto';
import { getRecentRooms, removeRecentRoom, RecentRoom } from '../utils/recentRooms';

const INTRO_TEXT = `This is a small kitchen.

The recipe box isn't labeled.
Nothing is listed. Nothing is advertised.
If you know a recipe, you already know how to open it.`;

export default function Home() {
  const navigate = useNavigate();
  const [recipeName, setRecipeName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>([]);

  useEffect(() => {
    setRecentRooms(getRecentRooms());
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const trimmedRecipeName = recipeName.trim();
    const trimmedPassphrase = passphrase.trim();

    if (!trimmedRecipeName || !trimmedPassphrase) {
      setError('Please enter both recipe name and passphrase.');
      setLoading(false);
      return;
    }

    try {
      // Fetch room metadata
      const room = await getRoom(trimmedRecipeName);

      // Derive key to verify passphrase can be derived
      // Actual decryption validation happens when loading messages
      await deriveKeyPBKDF2(
        trimmedPassphrase,
        room.saltB64,
        room.kdfIters
      );

      // Store credentials in sessionStorage for the room page
      sessionStorage.setItem(
        `recipe:${room.roomId}`,
        JSON.stringify({
          passphrase: trimmedPassphrase,
          version: room.version,
        })
      );

      // Navigate to room
      navigate(`/room/${room.roomId}`);
    } catch (err) {
      if (err instanceof Error && err.message === 'Recipe not found') {
        setError("Couldn't open this recipe.");
      } else {
        setError("Couldn't open this recipe.");
      }
      setLoading(false);
    }
  };

  const handleRecentClick = (room: RecentRoom) => {
    const stored = sessionStorage.getItem(`recipe:${room.roomId}`);
    if (stored) {
      navigate(`/room/${room.roomId}`);
    } else {
      setRecipeName(room.roomId);
      setError('');
    }
  };

  const handleRemoveRecent = (roomId: string) => {
    removeRecentRoom(roomId);
    setRecentRooms(getRecentRooms());
  };

  return (
    <div className="home">
      <div className="home-content">
        <div className="home-intro">{INTRO_TEXT}</div>

        <form className="home-form" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="recipe-name">Recipe name</label>
            <input
              id="recipe-name"
              type="text"
              value={recipeName}
              onChange={(e) => setRecipeName(e.target.value)}
              placeholder="Recipe name"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
            />
          </div>

          <div>
            <label htmlFor="passphrase">Passphrase</label>
            <input
              id="passphrase"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Passphrase"
              autoComplete="off"
            />
          </div>

          <button type="submit" disabled={loading}>
            {loading ? 'Opening...' : 'Open'}
          </button>

          {error && <div className="error-message">{error}</div>}

          <p className="home-warning">Lose the passphrase, lose the recipe.</p>
        </form>

        {recentRooms.length > 0 && (
          <div className="recent-rooms">
            <h2 className="recent-rooms-title">Recent recipes</h2>
            <ul className="recent-rooms-list">
              {recentRooms.map((room) => (
                <li key={room.roomId} className="recent-room-item">
                  <button
                    className="recent-room-link"
                    onClick={() => handleRecentClick(room)}
                  >
                    <span className="recent-room-name">{room.title}</span>
                    <span className="recent-room-id">{room.roomId}</span>
                  </button>
                  <button
                    className="recent-room-remove"
                    onClick={() => handleRemoveRecent(room.roomId)}
                    title="Remove"
                  >
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
