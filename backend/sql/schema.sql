CREATE TABLE IF NOT EXISTS rooms (
  id VARCHAR(48) PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(240) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS identities (
  peer_id VARCHAR(128) PRIMARY KEY,
  display_name VARCHAR(60) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS messages (
  id CHAR(36) PRIMARY KEY,
  room_id VARCHAR(48) NOT NULL,
  sender_id VARCHAR(128) NOT NULL,
  sender_name VARCHAR(60) NOT NULL,
  body VARCHAR(2000) NOT NULL,
  kind ENUM('chat', 'sos') NOT NULL DEFAULT 'chat',
  category VARCHAR(32) NULL,
  location VARCHAR(160) NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at BIGINT UNSIGNED NOT NULL,
  is_local BOOLEAN NOT NULL DEFAULT FALSE,
  publish_state ENUM('pending', 'published', 'received', 'expired') NOT NULL,
  INDEX room_history (room_id, created_at, id),
  INDEX pending_messages (is_local, publish_state, expires_at),
  FOREIGN KEY (room_id) REFERENCES rooms(id),
  FOREIGN KEY (sender_id) REFERENCES identities(peer_id)
);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id CHAR(36) NOT NULL,
  peer_id VARCHAR(128) NOT NULL,
  received_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (message_id, peer_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

INSERT IGNORE INTO rooms (id, name, description) VALUES
  ('general', 'General', 'Coordinate with everyone on your local network.'),
  ('rescue', 'Rescue coordination', 'Share updates with volunteers and response teams.'),
  ('supplies', 'Food & supplies', 'Coordinate water, food, shelter, and essential supplies.');
