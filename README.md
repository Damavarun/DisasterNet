# DisasterNet

Local-first emergency messaging using React.js, JavaScript, Tailwind CSS, Node.js, Express, WebSocket, MySQL, and libp2p (GossipSub + mDNS).

## Architecture

Each laptop runs a Node.js peer and its own local MySQL database. React connects to that peer through HTTP and WebSocket. Peers discover each other over an existing Wi-Fi, hotspot, or Ethernet LAN and exchange signed messages through GossipSub. Phones can use a laptop's LAN URL as browser clients. Internet is unnecessary; a reachable local network is required. This app does not create a Wi-Fi mesh.

## Features

- General, rescue, and supplies rooms with live messaging and history.
- SOS requests with category and optional location.
- MySQL transactions, stable message IDs, duplicate suppression, and persisted peer identity.
- Pending-message retries every five seconds and node-specific storage receipts.
- Bounded history catch-up: latest 100 unexpired messages per room, replayed by their original node when online.
- Peer discovery, manual peer connection, local PIN sessions, and responsive interface.

## Setup

Install Node.js 22.14 or newer and MySQL 8.0 or newer on every independent peer laptop.

Create a local database and account using your MySQL administrator:

```sql
CREATE DATABASE disasternet CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'disasternet'@'127.0.0.1' IDENTIFIED BY 'choose-a-local-password';
GRANT ALL PRIVILEGES ON disasternet.* TO 'disasternet'@'127.0.0.1';
```

From the project root:

```powershell
Copy-Item backend/.env.example backend/.env
# Edit MYSQL_PASSWORD and ACCESS_PIN in backend/.env.
npm ci
npm run db:migrate
npm run build
npm start
```

Open http://localhost:3001, enter your display name and configured access PIN. Phones on the same LAN can open http://LAPTOP_LAN_IP:3001.

For development use `npm run dev` and open the Vite URL. The Vite proxy targets backend port 3001.

On another laptop repeat setup with its own MySQL database and data directory. Use the same NETWORK_NAME. Allow Node.js TCP 9000, HTTP 3001, and mDNS UDP 5353 on your private network. If multicast discovery is blocked, use Connect node and paste the other laptop's complete LAN peer address. Do not use loopback addresses between devices. Network names and room names are channel selectors, not passwords.

## Validation

```powershell
npm run build
npm run lint
npm test
# Requires a disposable-test-capable local MySQL administrator:
$env:TEST_MYSQL_USER='root'
$env:TEST_MYSQL_PASSWORD='your-local-test-password'
npm run test:integration
```

Integration tests create uniquely named dn_it_* databases and remove only those databases afterward. Optional TEST_MYSQL_HOST and TEST_MYSQL_PORT select the test server. Tests cover two actual libp2p nodes, HTTP authentication, WebSocket updates, committed receipts, retries, duplicate suppression, restart recovery, synchronization, expiration, and mDNS.

The production build, lint check, and three unit tests pass. The MySQL + HTTP + WebSocket integration suite with two local libp2p nodes passed all seven checks. Automatic mDNS discovery timed out in this environment; manual peer connection works in the local integration test. Physical cross-device operation remains to be validated. For acceptance, disconnect internet while keeping LAN active, exchange messages between two laptops, restart a node, and verify pending messages and history catch-up.

## Status semantics and limitations

Pending means saved locally and waiting to publish. Published means broadcast, not delivered. A receipt identifies another node that committed the message to MySQL; it does not mean a person read it or rescue was dispatched. Display names are self-declared. Rescue assignment and verified announcements are not implemented. LAN browser sessions use HTTP; use a trusted local network. Noise protects peer links; messages are not end-to-end encrypted against subscribed peers. Keep backend/.env and backend/data private and back up MySQL together with the peer identity key.

## Project structure

- backend/src: API, MySQL store, peer network, and retry/sync service.
- backend/sql/schema.sql: rooms, identities, messages, and receipts.
- frontend/src: React dashboard and live connection client.
