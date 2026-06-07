const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const clients = new Map();

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.players = new Map();
    this.enemies = new Map();
    this.walls = [];
    this.score = 0;
    this.wave = 1;
    this.terrain = this.generateTerrain();
  }

  generateTerrain() {
    const walls = [];
    const WORLD_WIDTH = 3000;
    const WORLD_HEIGHT = 2000;
    const safeZone = { 
      x: WORLD_WIDTH / 2 - 120, 
      y: WORLD_HEIGHT / 2 - 120, 
      w: 240, 
      h: 240 
    };

    for (let i = 0; i < 18; i++) {
      let rock;
      let tries = 0;
      do {
        rock = {
          x: Math.random() * (WORLD_WIDTH - 180) + 20,
          y: Math.random() * (WORLD_HEIGHT - 180) + 20,
          w: 50 + Math.random() * 90,
          h: 50 + Math.random() * 90
        };
        tries++;
      } while (
        tries < 100 &&
        !(
          rock.x + rock.w < safeZone.x ||
          rock.x > safeZone.x + safeZone.w ||
          rock.y + rock.h < safeZone.y ||
          rock.y > safeZone.y + safeZone.h
        )
      );
      walls.push(rock);
    }
    return walls;
  }

  addPlayer(id, data) {
    this.players.set(id, {
      id,
      x: 1500,
      y: 1000,
      angle: 0,
      hp: 100,
      maxHp: 100,
      primary: data.primary || '#2e8bff',
      secondary: data.secondary || '#1a5fa8',
      treadOffset: 0,
      lastUpdate: Date.now()
    });
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.hostId === id && this.players.size > 0) {
      // Transfer host to next player
      this.hostId = this.players.keys().next().value;
    }
  }

  broadcast(message, excludeId = null) {
    const payload = JSON.stringify(message);
    clients.forEach((ws, clientId) => {
      if (clientId !== excludeId && ws.roomCode === this.code && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    });
  }
}

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(2, 9);
  clients.set(clientId, ws);
  ws.clientId = clientId;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleMessage(ws, clientId, message);
    } catch (e) {
      console.error('Message parse error:', e);
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
    if (ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) {
        room.removePlayer(clientId);
        if (room.players.size === 0) {
          rooms.delete(ws.roomCode);
        } else {
          room.broadcast({
            type: 'player-disconnected',
            id: clientId
          });
        }
      }
    }
  });
});

function handleMessage(ws, clientId, message) {
  const { type, roomCode, payload } = message;

  switch (type) {
    case 'create-room': {
      const code = generateRoomCode();
      const room = new Room(code, clientId);
      room.addPlayer(clientId, payload);
      rooms.set(code, room);
      ws.roomCode = code;

      ws.send(JSON.stringify({
        type: 'room-created',
        roomCode: code,
        terrain: room.terrain,
        isHost: true
      }));
      break;
    }

    case 'join-room': {
      const room = rooms.get(roomCode);
      if (!room) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Room not found'
        }));
        return;
      }

      room.addPlayer(clientId, payload);
      ws.roomCode = roomCode;

      // Send room state to joining player
      ws.send(JSON.stringify({
        type: 'room-joined',
        roomCode,
        terrain: room.terrain,
        isHost: false,
        hostId: room.hostId,
        players: Array.from(room.players.values()),
        enemies: Array.from(room.enemies.values()),
        wave: room.wave,
        score: room.score
      }));

      // Notify others
      room.broadcast({
        type: 'player-joined',
        player: room.players.get(clientId)
      }, clientId);
      break;
    }

    case 'player-move': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;

      const player = room.players.get(clientId);
      if (player) {
        player.x = payload.x;
        player.y = payload.y;
        player.angle = payload.angle;
        player.hp = payload.hp;
        player.treadOffset = payload.treadOffset;
        player.lastUpdate = Date.now();

        room.broadcast({
          type: 'player-move',
          id: clientId,
          x: payload.x,
          y: payload.y,
          angle: payload.angle,
          hp: payload.hp,
          treadOffset: payload.treadOffset
        }, clientId);
      }
      break;
    }

    case 'player-shoot': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;

      room.broadcast({
        type: 'player-shoot',
        id: clientId,
        x: payload.x,
        y: payload.y,
        angle: payload.angle
      }, clientId);
      break;
    }

    case 'player-skin': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;

      const player = room.players.get(clientId);
      if (player) {
        player.primary = payload.primary;
        player.secondary = payload.secondary;

        room.broadcast({
          type: 'player-skin',
          id: clientId,
          primary: payload.primary,
          secondary: payload.secondary
        }, clientId);
      }
      break;
    }

    case 'host-sync-enemies': {
      const room = rooms.get(ws.roomCode);
      if (!room || room.hostId !== clientId) return;

      room.enemies.clear();
      payload.enemies.forEach(e => room.enemies.set(e.id, e));

      room.broadcast({
        type: 'host-sync-enemies',
        enemies: payload.enemies
      }, clientId);
      break;
    }

    case 'host-wave-update': {
      const room = rooms.get(ws.roomCode);
      if (!room || room.hostId !== clientId) return;

      room.wave = payload.wave;
      room.score = payload.score;

      room.broadcast({
        type: 'host-wave-update',
        wave: payload.wave,
        score: payload.score
      }, clientId);
      break;
    }

    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    }
  }
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tank Survival Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});
