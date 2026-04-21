// server.js — A-Math Game Server (with complete endgame logic)
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
  createTileBag,
  shuffle,
  drawTiles,
  buildBoard,
  validatePlacement,
  calculateScore,
} from "./gameLogic.js";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT;

// ─── In-memory state ──────────────────────────────────────
const rooms = new Map(); // roomId → Room
const clients = new Map(); // ws → { playerId, roomId, name }

// Turn timeout: 3 minutes per turn (ms)
const TURN_TIMEOUT_MS = 3 * 60 * 1000;

// ─── Room factory ─────────────────────────────────────────
function createRoom(id, maxPlayers) {
  return {
    id,
    maxPlayers,
    players: [],
    board: null,
    tileBag: [],
    currentPlayerIndex: 0,
    gamePhase: "waiting", // waiting | playing | ended
    consecutivePasses: 0,
    turnNumber: 0,
    winner: null,
    winners: [], // NEW: array for tie support
    gameEndReason: null, // NEW: "EMPTY_HAND" | "ALL_PASS" | "TIMEOUT_STALL"
    moveHistory: [],
    createdAt: Date.now(),
    turnTimer: null, // NEW: server-side turn timer handle
  };
}

// ─── Broadcast helpers ────────────────────────────────────
function send(ws, type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcastRoom(roomId, type, payload = {}, excludeWs = null) {
  for (const [ws, meta] of clients) {
    if (meta.roomId === roomId && ws !== excludeWs) {
      send(ws, type, payload);
    }
  }
}

function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [ws, meta] of clients) {
    if (meta.roomId !== roomId) continue;
    const state = buildStateFor(room, meta.playerId);
    send(ws, "STATE_UPDATE", { state });
  }
}

function buildStateFor(room, playerId) {
  return {
    roomId: room.id,
    gamePhase: room.gamePhase,
    board: room.board,
    currentPlayerIndex: room.currentPlayerIndex,
    consecutivePasses: room.consecutivePasses,
    turnNumber: room.turnNumber,
    tileBagCount: room.tileBag.length,
    winner: room.winner,
    winners: room.winners, // NEW: expose tie info
    gameEndReason: room.gameEndReason, // NEW: expose reason
    moveHistory: room.moveHistory,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      rackCount: p.rack.length,
      rack: p.id === playerId ? p.rack : undefined,
      // NEW: after game ends, reveal all racks for transparency
      finalRack: room.gamePhase === "ended" ? p.rack : undefined,
    })),
  };
}

// ─── Lobby helpers ────────────────────────────────────────
function getRoomList() {
  return [...rooms.values()]
    .filter((r) => r.gamePhase === "waiting")
    .map((r) => ({
      id: r.id,
      playerCount: r.players.filter((p) => p.connected).length,
      maxPlayers: r.maxPlayers,
      createdAt: r.createdAt,
    }));
}

function broadcastLobby() {
  const list = getRoomList();
  for (const [ws, meta] of clients) {
    if (!meta.roomId) send(ws, "ROOM_LIST", { rooms: list });
  }
}

// ─── Turn timer ───────────────────────────────────────────
/**
 * Start (or restart) the per-turn server timer.
 * When it fires, auto-pass for the current player.
 */
function startTurnTimer(room) {
  clearTurnTimer(room);
  room.turnTimer = setTimeout(() => {
    if (room.gamePhase !== "playing") return;
    const player = room.players[room.currentPlayerIndex];
    console.log(`[${room.id}] Turn timeout — auto-passing for ${player.name}`);
    applyPass(room, player, "timeout");
    broadcastRoomState(room.id);
  }, TURN_TIMEOUT_MS);
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

// ─── Game start ───────────────────────────────────────────
function startGame(room) {
  const bag = createTileBag();
  let remaining = bag;
  room.board = buildBoard();

  for (const player of room.players) {
    const [drawn, rest] = drawTiles(remaining, 8);
    player.rack = drawn;
    player.score = 0;
    remaining = rest;
  }

  room.tileBag = remaining;
  room.currentPlayerIndex = 0;
  room.gamePhase = "playing";
  room.consecutivePasses = 0;
  room.turnNumber = 1;
  room.moveHistory = [];
  room.winner = null;
  room.winners = [];
  room.gameEndReason = null;

  startTurnTimer(room);
}

function isBoardEmpty(board) {
  return board.every((row) => row.every((cell) => !cell.tile));
}

// ─── Core: advance to next connected player ───────────────
/**
 * Advance currentPlayerIndex to the next connected player.
 * Returns false if NO connected players remain (shouldn't happen normally).
 */
function advanceTurn(room) {
  const n = room.players.length;
  let tries = 0;
  do {
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % n;
    tries++;
  } while (!room.players[room.currentPlayerIndex].connected && tries < n);
  room.turnNumber++;
  startTurnTimer(room);
}

// ─── Core: endGame — THE single source of truth ──────────
/**
 * Finalise the game.
 *
 * Scoring rules (official A-Math / Scrabble hybrid):
 *  1. Every player LOSES the sum of points on tiles still in their rack.
 *  2. If exactly one player emptied their rack (Case A), that player GAINS
 *     the sum of all other players' rack penalties as a bonus.
 *  3. Highest adjusted score wins. Ties are honoured (multiple winners).
 *
 * @param {object} room
 * @param {"EMPTY_HAND"|"ALL_PASS"|"TIMEOUT_STALL"} reason
 */
function endGame(room, reason = "EMPTY_HAND") {
  clearTurnTimer(room);

  // 1. Deduct remaining tile points from every player
  for (const p of room.players) {
    const penalty = p.rack.reduce((sum, t) => sum + (t.points || 0), 0);
    p.score -= penalty;
    p.rackPenalty = penalty; // store for UI transparency
  }

  // 2. Bonus for the player who emptied their rack (Case A only)
  if (reason === "EMPTY_HAND") {
    const emptyHandPlayers = room.players.filter((p) => p.rack.length === 0);
    // Normally exactly one player empties hand, but guard for edge cases
    if (emptyHandPlayers.length === 1) {
      const finisher = emptyHandPlayers[0];
      const bonus = room.players
        .filter((p) => p.id !== finisher.id)
        .reduce((sum, p) => sum + (p.rackPenalty || 0), 0);
      finisher.score += bonus;
      finisher.emptyHandBonus = bonus; // for UI
    }
  }

  // 3. Find winner(s) — handle ties
  const maxScore = Math.max(...room.players.map((p) => p.score));
  const topPlayers = room.players.filter((p) => p.score === maxScore);

  // Primary winner (first in array among top — or only one)
  const winner = topPlayers[0];
  room.winner = { id: winner.id, name: winner.name, score: winner.score };

  // Full winners list (for tie display)
  room.winners = topPlayers.map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
  }));

  room.gameEndReason = reason;
  room.gamePhase = "ended";

  console.log(
    `[${room.id}] Game ended (${reason}). Winner: ${winner.name} (${winner.score}pts)` +
      (topPlayers.length > 1 ? ` — TIE with ${topPlayers.length} players` : ""),
  );
}

// ─── Core: apply a pass action ────────────────────────────
/**
 * Apply a pass (or auto-pass) for a player.
 * Checks if this triggers game end via ALL_PASS rule.
 *
 * Connected-player pass threshold:
 *   We count passes needed = connectedPlayers * 2
 *   This prevents disconnected players from inflating the pass counter
 *   making the game end too early.
 *
 * Returns true if the game ended.
 */
function applyPass(room, player, passType = "manual") {
  room.consecutivePasses++;

  room.moveHistory.push({
    playerName: player.name,
    type: "pass",
    score: 0,
    equations: [],
    turnNumber: room.turnNumber,
    passType, // "manual" | "exchange" | "timeout"
  });

  const connectedCount = room.players.filter((p) => p.connected).length;
  const passThreshold = Math.max(connectedCount * 2, room.players.length * 2);

  if (room.consecutivePasses >= passThreshold) {
    endGame(room, "ALL_PASS");
    return true; // game ended
  }

  advanceTurn(room);
  return false;
}

// ─── evaluateGameEnd — check after COMMIT_MOVE ───────────
/**
 * After a successful tile placement, check if the game should end.
 * Returns true if the game ended.
 */
function evaluateGameEnd(room, player) {
  const bagEmpty = room.tileBag.length === 0;
  const handEmpty = player.rack.length === 0;

  if (bagEmpty && handEmpty) {
    endGame(room, "EMPTY_HAND");
    return true;
  }

  // Edge case: bag is not empty but ALL players have 0 tiles
  // (extremely rare, would require everyone to play out simultaneously — not
  //  possible in turn-based, but guard anyway)
  const allEmpty = room.players.every((p) => p.rack.length === 0);
  if (allEmpty) {
    endGame(room, "EMPTY_HAND");
    return true;
  }

  return false;
}

// ─── Message handlers ────────────────────────────────────
const handlers = {
  // ── Lobby ────────────────────────────────────────────
  GET_ROOMS(ws) {
    send(ws, "ROOM_LIST", { rooms: getRoomList() });
  },

  CREATE_ROOM(ws, { name, maxPlayers = 4 }) {
    const roomId = Math.random().toString(36).slice(2, 7).toUpperCase();
    const playerId = randomUUID();
    const room = createRoom(roomId, Math.min(Math.max(maxPlayers, 2), 4));
    const player = { id: playerId, name, score: 0, rack: [], connected: true };
    room.players.push(player);
    rooms.set(roomId, room);
    clients.set(ws, { playerId, roomId, name });

    send(ws, "ROOM_JOINED", {
      roomId,
      playerId,
      isHost: true,
      state: buildStateFor(room, playerId),
    });
    broadcastLobby();
    console.log(`[${roomId}] Created by ${name}`);
  },

  JOIN_ROOM(ws, { roomId, name }) {
    const room = rooms.get(roomId);
    if (!room) return send(ws, "ERROR", { message: "ไม่พบห้องนี้" });
    if (room.gamePhase !== "waiting")
      return send(ws, "ERROR", { message: "เกมเริ่มไปแล้ว" });
    if (room.players.filter((p) => p.connected).length >= room.maxPlayers)
      return send(ws, "ERROR", { message: "ห้องเต็มแล้ว" });

    const existing = room.players.find((p) => p.name === name && !p.connected);
    let playerId;
    if (existing) {
      existing.connected = true;
      playerId = existing.id;
    } else {
      playerId = randomUUID();
      room.players.push({
        id: playerId,
        name,
        score: 0,
        rack: [],
        connected: true,
      });
    }

    clients.set(ws, { playerId, roomId, name });
    send(ws, "ROOM_JOINED", {
      roomId,
      playerId,
      isHost: false,
      state: buildStateFor(room, playerId),
    });
    broadcastRoom(
      roomId,
      "PLAYER_JOINED",
      { name, playerCount: room.players.length },
      ws,
    );
    broadcastRoomState(roomId);
    broadcastLobby();
    console.log(
      `[${roomId}] ${name} joined (${room.players.length}/${room.maxPlayers})`,
    );
  },

  START_GAME(ws) {
    const meta = clients.get(ws);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;
    if (room.players[0].id !== meta.playerId)
      return send(ws, "ERROR", { message: "เฉพาะ host เท่านั้น" });
    if (room.players.filter((p) => p.connected).length < 2)
      return send(ws, "ERROR", { message: "ต้องมีผู้เล่นอย่างน้อย 2 คน" });

    startGame(room);
    broadcastRoomState(meta.roomId);
    broadcastLobby();
    console.log(
      `[${meta.roomId}] Game started with ${room.players.length} players`,
    );
  },

  // ── Gameplay ──────────────────────────────────────────
  COMMIT_MOVE(ws, { placed }) {
    const meta = clients.get(ws);
    if (!meta) return;
    const room = rooms.get(meta.roomId);

    // Guard: game must be playing
    if (!room || room.gamePhase !== "playing")
      return send(ws, "ERROR", { message: "เกมไม่ได้อยู่ในสถานะ playing" });

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== meta.playerId)
      return send(ws, "ERROR", { message: "ไม่ใช่เทิร์นของคุณ" });
    if (!placed?.length)
      return send(ws, "ERROR", { message: "ยังไม่ได้วางเบี้ย" });

    // Validate tiles belong to player
    const rackIds = new Set(currentPlayer.rack.map((t) => t.id));
    if (!placed.every((p) => rackIds.has(p.tile.id)))
      return send(ws, "ERROR", { message: "เบี้ยไม่ถูกต้อง" });

    const isFirst = isBoardEmpty(room.board);
    const { valid, error, equations } = validatePlacement(
      room.board,
      placed,
      isFirst,
    );
    if (!valid) return send(ws, "ERROR", { message: error });

    const score = calculateScore(room.board, placed, equations);
    const bingo = placed.length === 8;

    // Apply tiles to board
    for (const p of placed) {
      room.board[p.row][p.col] = { ...room.board[p.row][p.col], tile: p.tile };
    }

    // Remove placed tiles from rack
    const placedIds = new Set(placed.map((p) => p.tile.id));
    currentPlayer.rack = currentPlayer.rack.filter((t) => !placedIds.has(t.id));
    currentPlayer.score += score;

    // Replenish from bag
    const drawCount = Math.min(placed.length, room.tileBag.length);
    const [drawn, newBag] = drawTiles(room.tileBag, drawCount);
    currentPlayer.rack.push(...drawn);
    room.tileBag = newBag;

    // Record move
    const eqStrings = equations.map((eq) =>
      eq.map((t) => (t.isBlank ? t.blankValue || "?" : t.value)).join(" "),
    );
    room.moveHistory.push({
      playerName: currentPlayer.name,
      type: "place",
      score,
      equations: eqStrings,
      bingo,
      turnNumber: room.turnNumber,
    });

    // Reset consecutive passes — a successful move breaks any pass streak
    room.consecutivePasses = 0;

    console.log(
      `[${room.id}] ${currentPlayer.name} scored ${score}${bingo ? " 🎉 BINGO" : ""}`,
    );

    // ── Check game end (Case A) ───────────────────────────
    if (evaluateGameEnd(room, currentPlayer)) {
      broadcastRoomState(meta.roomId);
      return;
    }

    // ── Continue: advance turn ────────────────────────────
    advanceTurn(room);
    broadcastRoomState(meta.roomId);
  },

  PASS_MOVE(ws) {
    const meta = clients.get(ws);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    if (!room || room.gamePhase !== "playing")
      return send(ws, "ERROR", { message: "เกมไม่ได้อยู่ในสถานะ playing" });

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== meta.playerId)
      return send(ws, "ERROR", { message: "ไม่ใช่เทิร์นของคุณ" });

    const ended = applyPass(room, currentPlayer, "manual");
    broadcastRoomState(meta.roomId);

    if (!ended) {
      console.log(
        `[${room.id}] ${currentPlayer.name} passed (${room.consecutivePasses} consecutive)`,
      );
    }
  },

  EXCHANGE_TILES(ws, { tileIds }) {
    const meta = clients.get(ws);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    if (!room || room.gamePhase !== "playing")
      return send(ws, "ERROR", { message: "เกมไม่ได้อยู่ในสถานะ playing" });

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== meta.playerId)
      return send(ws, "ERROR", { message: "ไม่ใช่เทิร์นของคุณ" });

    // Need at least as many tiles in bag as we're exchanging (standard rule: bag >= tiles to exchange)
    if (room.tileBag.length < tileIds.length)
      return send(ws, "ERROR", { message: "เบี้ยในถุงไม่พอสำหรับการเปลี่ยน" });

    const toExchange = currentPlayer.rack.filter((t) => tileIds.includes(t.id));
    if (toExchange.length === 0)
      return send(ws, "ERROR", { message: "ไม่พบเบี้ยที่ต้องการเปลี่ยน" });

    currentPlayer.rack = currentPlayer.rack.filter(
      (t) => !tileIds.includes(t.id),
    );
    const [drawn, newBag] = drawTiles(room.tileBag, toExchange.length);
    currentPlayer.rack.push(...drawn);
    room.tileBag = shuffle([...newBag, ...toExchange]);

    room.moveHistory.push({
      playerName: currentPlayer.name,
      type: "exchange",
      score: 0,
      equations: [],
      turnNumber: room.turnNumber,
    });

    // ✅ FIX: Exchange counts as a pass for the consecutive-pass counter
    // (was incorrectly reset to 0 in original code)
    room.consecutivePasses++;

    console.log(
      `[${room.id}] ${currentPlayer.name} exchanged ${toExchange.length} tiles`,
    );

    // Check if exchange tips ALL_PASS threshold (rare but possible)
    const connectedCount = room.players.filter((p) => p.connected).length;
    const passThreshold = Math.max(connectedCount * 2, room.players.length * 2);
    if (room.consecutivePasses >= passThreshold) {
      endGame(room, "ALL_PASS");
      broadcastRoomState(meta.roomId);
      return;
    }

    advanceTurn(room);
    broadcastRoomState(meta.roomId);
  },

  // ── Chat ──────────────────────────────────────────────
  CHAT(ws, { message }) {
    const meta = clients.get(ws);
    if (!meta || !message?.trim()) return;
    broadcastRoom(meta.roomId, "CHAT", {
      from: meta.name,
      message: message.slice(0, 200),
    });
  },

  LEAVE_ROOM(ws) {
    handleDisconnect(ws);
  },
};

// ─── Disconnect handler ───────────────────────────────────
function handleDisconnect(ws) {
  const meta = clients.get(ws);
  if (!meta) return;
  const { playerId, roomId, name } = meta;
  clients.delete(ws);

  const room = rooms.get(roomId);
  if (!room) return;

  const player = room.players.find((p) => p.id === playerId);
  if (player) player.connected = false;

  broadcastRoom(roomId, "PLAYER_LEFT", { name });

  const anyConnected = room.players.some((p) => p.connected);
  if (!anyConnected) {
    clearTurnTimer(room);
    rooms.delete(roomId);
    console.log(`[${roomId}] Room deleted (empty)`);
    broadcastLobby();
    return;
  }

  // If the disconnected player was the current player, auto-pass their turn
  if (
    room.gamePhase === "playing" &&
    room.players[room.currentPlayerIndex]?.id === playerId
  ) {
    console.log(
      `[${roomId}] Current player ${name} disconnected — auto-passing`,
    );
    applyPass(room, player, "disconnect");
    broadcastRoomState(roomId);
  }

  broadcastLobby();
  console.log(`[${roomId}] ${name} disconnected`);
}

// ─── Server setup ─────────────────────────────────────────
const httpServer = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/health") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: "ok",
        rooms: rooms.size,
        clients: clients.size,
      }),
    );
  } else {
    res.writeHead(404);
    res.end("A-Math Server");
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  console.log("Client connected");
  clients.set(ws, { playerId: null, roomId: null, name: null });

  ws.on("message", (raw) => {
    try {
      const { type, ...payload } = JSON.parse(raw);
      const handler = handlers[type];
      if (handler) handler(ws, payload);
      else console.warn("Unknown message type:", type);
    } catch (e) {
      console.error("Message error:", e.message);
    }
  });

  ws.on("close", () => handleDisconnect(ws));
  ws.on("error", (e) => console.error("WS error:", e.message));
});

httpServer.listen(PORT, () => {
  console.log(`🎮 A-Math Server running on ws://localhost:${PORT}`);
});
