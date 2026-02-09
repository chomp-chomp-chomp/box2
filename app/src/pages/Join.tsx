import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getRoom } from '../utils/api';

export default function Join() {
  const { roomId, passphrase: pathPassphrase } = useParams<{ roomId: string; passphrase?: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!roomId) {
      navigate('/');
      return;
    }

    // Try path param first (survives messaging apps), then fragment (legacy)
    const passphrase = pathPassphrase
      ? decodeURIComponent(pathPassphrase)
      : decodeURIComponent(window.location.hash.slice(1));

    if (!passphrase) {
      setError('This link is missing the passphrase. Ask the person who shared it for a new one.');
      return;
    }

    const joinRoom = async () => {
      try {
        const room = await getRoom(roomId);

        // Store credentials in localStorage so they persist across sessions
        localStorage.setItem(
          `recipe:${room.roomId}`,
          JSON.stringify({
            passphrase,
            version: room.version,
          })
        );

        // Clear the passphrase from URL history before navigating
        window.history.replaceState(null, '', `/join/${encodeURIComponent(roomId)}`);

        navigate(`/room/${room.roomId}`, { replace: true });
      } catch {
        setError("Couldn't find this recipe. The link may be invalid.");
      }
    };

    joinRoom();
  }, [roomId, pathPassphrase, navigate]);

  if (error) {
    return (
      <div className="home">
        <div className="home-content">
          <p className="error-message">{error}</p>
          <Link to="/" style={{ marginTop: '1rem', display: 'inline-block' }}>
            Go to home page
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="home">
      <div className="home-content">
        <p>Opening recipe...</p>
      </div>
    </div>
  );
}
