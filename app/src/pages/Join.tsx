import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getRoom } from '../utils/api';

export default function Join() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!roomId) {
      navigate('/');
      return;
    }

    // Read passphrase from URL fragment (never sent to server)
    const passphrase = window.location.hash.slice(1);
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

        // Clear the fragment from URL history before navigating
        window.history.replaceState(null, '', window.location.pathname);

        navigate(`/room/${room.roomId}`, { replace: true });
      } catch {
        setError("Couldn't find this recipe. The link may be invalid.");
      }
    };

    joinRoom();
  }, [roomId, navigate]);

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
