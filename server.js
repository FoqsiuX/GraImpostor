const http = require('http');
const path = require('path');
const fs = require('fs');
const { randomInt } = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const words = ['dom', 'chmura', 'ka\u0142amarz', 'silnik', 'pr\u0105d'];
const lobbies = new Map();

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function generateCode() {
  return String(randomInt(0, 1e8)).padStart(8, '0');
}

function cleanName(name) {
  return (name || '').trim().slice(0, 32);
}

function lobbySummary(lobby) {
  return {
    code: lobby.code,
    difficulty: lobby.difficulty,
    maxPlayers: lobby.maxPlayers,
    players: lobby.players.map(p => ({ id: p.id, name: p.name, isAdmin: p.isAdmin })),
    started: lobby.started,
    filled: lobby.players.length >= lobby.maxPlayers,
    createdAt: lobby.createdAt
  };
}

function handleApi(req, res) {
  const url = new URL(req.url, 'http://' + req.headers.host);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/lobby/state') {
    const code = url.searchParams.get('code');
    const lobby = lobbies.get(code);
    if (!lobby) return sendJson(res, 404, { ok: false, error: 'Lobby nie istnieje' });
    return sendJson(res, 200, { ok: true, lobby: lobbySummary(lobby) });
  }

  if (req.method === 'GET' && url.pathname === '/api/lobby/role') {
    const code = url.searchParams.get('code');
    const playerId = Number(url.searchParams.get('playerId'));
    const lobby = lobbies.get(code);
    if (!lobby) return sendJson(res, 404, { ok: false, error: 'Lobby nie istnieje' });
    if (!lobby.started) return sendJson(res, 400, { ok: false, error: 'Gra jeszcze nie wystartowa\u0142a' });
    const player = lobby.players.find(p => p.id === playerId);
    if (!player) return sendJson(res, 404, { ok: false, error: 'Nie znaleziono gracza' });
    const isImpostor = lobby.impostorId === player.id;
    return sendJson(res, 200, { ok: true, isImpostor, word: isImpostor ? null : lobby.word });
  }

  if (req.method === 'POST' && url.pathname === '/api/lobby/create') {
    return parseBody(req)
      .then(body => {
        const { adminPassword, adminName, maxPlayers, difficulty } = body;
        if (adminPassword !== ADMIN_PASSWORD) {
          return sendJson(res, 401, { ok: false, error: 'B\u0142\u0119dne has\u0142o administratora' });
        }
        const name = cleanName(adminName);
        const difficultyOptions = ['latwy', 'sredni', 'trudny'];
        const difficultyValue = difficultyOptions.includes(difficulty) ? difficulty : 'latwy';
        const max = Math.min(Math.max(parseInt(maxPlayers, 10) || 3, 3), 12);
        if (!name) {
          return sendJson(res, 400, { ok: false, error: 'Podaj nazw\u0119 admina' });
        }

        let code = generateCode();
        while (lobbies.has(code)) {
          code = generateCode();
        }

        const lobby = {
          code,
          difficulty: difficultyValue,
          maxPlayers: max,
          players: [{ id: 1, name, isAdmin: true }],
          started: false,
          impostorId: null,
          word: null,
          createdAt: Date.now()
        };
        lobbies.set(code, lobby);
        return sendJson(res, 200, {
          ok: true,
          code,
          playerId: 1,
          lobby: lobbySummary(lobby)
        });
      })
      .catch(err => {
        console.error('create error', err);
        sendJson(res, 400, { ok: false, error: 'Nie uda\u0142o si\u0119 utworzy\u0107 lobby' });
      });
  }

  if (req.method === 'POST' && url.pathname === '/api/lobby/join') {
    return parseBody(req)
      .then(body => {
        const { code, name } = body;
        const lobby = lobbies.get(code);
        if (!lobby) return sendJson(res, 404, { ok: false, error: 'Lobby nie istnieje' });
        if (lobby.started) return sendJson(res, 400, { ok: false, error: 'Gra ju\u017c wystartowa\u0142a' });
        if (lobby.players.length >= lobby.maxPlayers) return sendJson(res, 400, { ok: false, error: 'Lobby jest pe\u0142ne' });
        const playerName = cleanName(name);
        if (!playerName) return sendJson(res, 400, { ok: false, error: 'Podaj nazw\u0119 gracza' });
        if (lobby.players.some(p => p.name.toLowerCase() === playerName.toLowerCase())) {
          return sendJson(res, 400, { ok: false, error: 'Ta nazwa jest ju\u017c zaj\u0119ta w tym lobby' });
        }
        const player = { id: lobby.players.length + 1, name: playerName, isAdmin: false };
        lobby.players.push(player);
        return sendJson(res, 200, { ok: true, playerId: player.id, lobby: lobbySummary(lobby) });
      })
      .catch(err => {
        console.error('join error', err);
        sendJson(res, 400, { ok: false, error: 'Nie uda\u0142o si\u0119 do\u0142\u0105czy\u0107' });
      });
  }

  if (req.method === 'POST' && url.pathname === '/api/lobby/start') {
    return parseBody(req)
      .then(body => {
        const { code, adminPassword } = body;
        const lobby = lobbies.get(code);
        if (!lobby) return sendJson(res, 404, { ok: false, error: 'Lobby nie istnieje' });
        if (adminPassword !== ADMIN_PASSWORD) {
          return sendJson(res, 401, { ok: false, error: 'B\u0142\u0119dne has\u0142o administratora' });
        }
        if (lobby.started) return sendJson(res, 400, { ok: false, error: 'Gra ju\u017c zosta\u0142a uruchomiona' });
        if (lobby.players.length < 3) {
          return sendJson(res, 400, { ok: false, error: 'Potrzeba co najmniej 3 graczy' });
        }
        lobby.started = true;
        lobby.impostorId = lobby.players[randomInt(0, lobby.players.length)].id;
        lobby.word = words[randomInt(0, words.length)];
        return sendJson(res, 200, { ok: true, lobby: lobbySummary(lobby) });
      })
      .catch(err => {
        console.error('start error', err);
        sendJson(res, 400, { ok: false, error: 'Nie uda\u0142o si\u0119 uruchomi\u0107 gry' });
      });
  }

  return false;
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://' + req.headers.host);
  let filePath = path.join(__dirname, url.pathname);
  if (url.pathname === '/' || url.pathname === '') {
    filePath = path.join(__dirname, 'index.html');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath);
    const contentType = contentTypes[ext] || 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    if (handleApi(req, res) !== false) return;
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Nie znaleziono' }));
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('Serwer wystartowa\u0142 na http://localhost:' + PORT);
});
