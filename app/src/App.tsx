import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Room from './pages/Room';
import Join from './pages/Join';
import Admin from './pages/Admin';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/room/:roomId" element={<Room />} />
      <Route path="/join/:roomId" element={<Join />} />
      <Route path="/admin" element={<Admin />} />
    </Routes>
  );
}

export default App;
