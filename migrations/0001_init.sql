-- Create rooms table
CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  title TEXT,
  salt_b64 TEXT NOT NULL,
  kdf_iters INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Create messages table
CREATE TABLE IF NOT EXISTS messages (
  room_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  iv_b64 TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  sender_name TEXT,
  PRIMARY KEY (room_id, msg_id)
);

-- Create index for efficient message retrieval
CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);
