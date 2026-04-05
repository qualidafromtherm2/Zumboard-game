# Copilot instructions

## Project overview
- Frontend is a single static page with inline JS in index.html (auth, rooms, game UI) plus styles.css.
- Backend is a Node/Express API in backend/server.js backed by PostgreSQL (schema in database/schema.sql).
- Assets (board, cards, videos) live in Cartas/ and Fundo da pagina/; frontend uses relative paths.

## Architecture & data flow
- Frontend sets API base in index.html: `API_URL = 'http://localhost:3000/api'`; JWT is stored as localStorage `authToken` and sent as `Authorization: Bearer <token>`.
- Backend serves static card images from `/Cartas` (express.static points at Cartas/).
- Core endpoints: /api/register, /api/login, /api/verify, /api/rooms/*, /api/cards/*, /api/cartela/* (all in backend/server.js).
- Room state lives in mtkin.rooms.status (waiting/playing/finished) and online presence in mtkin.room_participants.
- Game start deals 4 door + 4 treasure cards, stored in mtkin.cartas_no_jogo with tipo_baralho = 'porta'|'tesouro'.
- Hands are read via /api/cards/door-hand and /api/cards/treasure-hand; fallbacks via /api/cards/door-random and /api/cards/treasure-random.
- Drag/drop from the leque to cartela slots (labels 77-89) calls /api/cartela/slot which upserts mtkin.cartas_ativas and removes from mtkin.cartas_no_jogo.
- Door monster sequence is tracked in-memory per room (doorMonstrosIndexByRoomId); reset occurs on server restart.

## Dev workflows (VS Code tasks)
- Start both servers: Terminal -> Run Task -> Start frontend + backend.
- Stop servers: Terminal -> Run Task -> Stop all (frontend + backend).
- Frontend runs on port 5500 (Python http.server); backend on port 3000 (node server.js).
- When edits require a restart (backend routes/schema, frontend static assets), restart the affected server(s) without asking.

## Database access (schema)
- Schema source of truth: database/schema.sql; applied via backend/apply-schema.js.
- Connection uses env vars: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSL.
- PowerShell example:
	- `$env:DB_HOST='<host>'; $env:DB_PORT='5432'; $env:DB_NAME='<db>'; $env:DB_USER='<user>'; $env:DB_PASSWORD='<pass>'; $env:DB_SSL='true'; node backend/apply-schema.js`
- Seed scripts: backend/create-door-cards.js and backend/create-treasure-cards.js.

## Project conventions & patterns
- Keep UI state mutations inside index.html; prefer small helpers over new files (no bundler).
- Always include Authorization header on API calls that require auth.
- When updating room status, keep `currentRoom.status` in sync so UI controls match server state.
- The leque (fan) renders from `card.caminho_imagem` paths served by the frontend origin (http.server on 5500).

## Key files to reference
- index.html, styles.css
- backend/server.js, backend/package.json
- database/schema.sql
- .vscode/tasks.json
