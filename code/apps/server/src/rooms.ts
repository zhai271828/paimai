import {
  RuleError,
  addPlayer,
  createRoomState,
  getPlayerView,
  makeId,
  makeJoinCode,
  reduceGame
} from "@auctioneer/engine";
import type {
  ActionLog,
  ClientToServerEvents,
  GameState,
  PlayerId,
  PlayerView,
  RuleErrorCode,
  RoomId,
  ServerAction,
  ServerToClientEvents
} from "@auctioneer/shared";
import type { Server, Socket } from "socket.io";
import { InMemoryRoomRepository, snapshotFromState, type RoomRepository } from "./persistence.js";
import { actionRateOptions, RateLimitError, socketOriginAllowed, socketRateKey, type RateLimiter } from "./security.js";

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type GameServer = Server<ClientToServerEvents, ServerToClientEvents>;

interface SessionRecord {
  token: string;
  roomId: RoomId;
  playerId: PlayerId;
}

interface SocketData {
  roomId?: RoomId;
  playerId?: PlayerId;
  token?: string;
}

export interface RoomStore {
  rooms: Map<RoomId, GameState>;
  joinCodes: Map<string, RoomId>;
  sessions: Map<string, SessionRecord>;
  actionQueues: Map<RoomId, Promise<void>>;
  offlineTimers: Map<string, ReturnType<typeof setTimeout>>;
  phaseTimers: Map<RoomId, ReturnType<typeof setTimeout>>;
  repository: RoomRepository;
}

export interface RoomHandlerOptions {
  allowedOrigins?: string[];
  rateLimiter?: RateLimiter;
}

export function createRoomStore(repository: RoomRepository = new InMemoryRoomRepository()): RoomStore {
  return {
    rooms: new Map(),
    joinCodes: new Map(),
    sessions: new Map(),
    actionQueues: new Map(),
    offlineTimers: new Map(),
    phaseTimers: new Map(),
    repository
  };
}

export function restoreRoomIntoStore(store: RoomStore, roomId: RoomId): GameState | undefined {
  const snapshot = store.repository.loadLatestSnapshot(roomId);
  if (!snapshot) return undefined;
  if (snapshot.state.closedAt) return undefined;
  store.rooms.set(snapshot.state.roomId, snapshot.state);
  store.joinCodes.set(snapshot.state.joinCode, snapshot.state.roomId);
  return snapshot.state;
}

export function restorePersistedRoomsIntoStore(store: RoomStore): GameState[] {
  const snapshots = store.repository.loadLatestSnapshots?.() ?? [];
  for (const snapshot of snapshots.filter((candidate) => !candidate.state.closedAt)) {
    store.rooms.set(snapshot.state.roomId, snapshot.state);
    store.joinCodes.set(snapshot.state.joinCode, snapshot.state.roomId);
  }
  return snapshots.filter((snapshot) => !snapshot.state.closedAt).map((snapshot) => snapshot.state);
}

export function registerRoomHandlers(io: GameServer, store: RoomStore, options: RoomHandlerOptions = {}): void {
  io.on("connection", (socket: GameSocket) => {
    if (!socketOriginAllowed(socket, options.allowedOrigins)) {
      socket.emit("room:error", { message: "连接来源不被允许。", code: "INVALID_ACTION" });
      socket.disconnect(true);
      return;
    }
    if (!checkSocketRate(socket, options.rateLimiter, "connect")) {
      socket.emit("room:error", { message: "连接过于频繁，请稍后再试。", code: "INVALID_ACTION" });
      socket.disconnect(true);
      return;
    }

    socket.on("room:create", (payload, ack) => {
      safeAck(ack, () => {
        assertSocketRate(socket, options.rateLimiter, "room:create");
        const roomId = makeId("room");
        let joinCode = makeJoinCode();
        while (store.joinCodes.has(joinCode)) joinCode = makeJoinCode();
        let room = createRoomState({ roomId, joinCode });
        const playerId = makeId("player");
        room = addPlayer(room, playerId, payload.nickname);
        store.rooms.set(roomId, room);
        store.joinCodes.set(joinCode, roomId);
        const token = createSession(store, roomId, playerId);
        persistSnapshot(store, room);
        attachSocket(socket, roomId, playerId, token);
        socket.join(roomId);
        socket.join(playerChannel(roomId, playerId));
        broadcastRoom(io, store, roomId);
        return { view: getPlayerView(room, playerId), sessionToken: token };
      });
    });

    socket.on("room:join", (payload, ack) => {
      safeAck(ack, () => {
        assertSocketRate(socket, options.rateLimiter, "room:join");
        const roomId = store.joinCodes.get(payload.joinCode.trim().toUpperCase());
        if (!roomId) throw new RuleError("房间不存在。");
        const room = requireRoom(store, roomId);
        const playerId = makeId("player");
        const next = addPlayer(room, playerId, payload.nickname);
        store.rooms.set(roomId, next);
        const token = createSession(store, roomId, playerId);
        persistSnapshot(store, next);
        attachSocket(socket, roomId, playerId, token);
        socket.join(roomId);
        socket.join(playerChannel(roomId, playerId));
        broadcastRoom(io, store, roomId);
        return { view: getPlayerView(next, playerId), sessionToken: token };
      });
    });

    socket.on("room:resume", (payload, ack) => {
      safeAck(ack, () => {
        assertSocketRate(socket, options.rateLimiter, "room:resume");
        const session = loadSession(store, payload.sessionToken);
        if (!session || session.roomId !== payload.roomId || session.playerId !== payload.playerId) {
          throw new RuleError("会话已失效。");
        }
        if (!store.rooms.has(session.roomId)) restoreRoomIntoStore(store, session.roomId);
        const room = requireRoom(store, session.roomId);
        const player = room.players.find((candidate) => candidate.id === session.playerId);
        if (!player || player.kicked) throw new RuleError("你已被移出房间。", "SESSION_INVALID");
        attachSocket(socket, session.roomId, session.playerId, session.token);
        socket.join(session.roomId);
        socket.join(playerChannel(session.roomId, session.playerId));
        clearOfflineAutomation(store, session.roomId, session.playerId);
        updateRoom(io, store, session.roomId, {
          type: "SET_CONNECTED",
          playerId: session.playerId,
          payload: { connected: true }
        });
        return { view: getPlayerView(requireRoom(store, session.roomId), session.playerId) };
      });
    });

    socket.on("player:ready", (payload, ack) => handleAction(io, store, socket, ack, "SET_READY", payload, options));
    socket.on("room:start", (payload, ack) => handleAction(io, store, socket, ack, "START_GAME", payload, options));
    socket.on("phase:advance", (payload, ack) => handleAction(io, store, socket, ack, "ADVANCE_PHASE", payload, options));
    socket.on("blackMarket:buy", (payload, ack) => handleAction(io, store, socket, ack, "BUY_BLACK_MARKET", payload, options));
    socket.on("host:setAuction", (_payload, ack) => {
      safeAck(ack, () => {
        throw new RuleError("拍卖方式由系统随机生成。", "INVALID_ACTION");
      });
    });
    socket.on("bid:place", (payload, ack) => handleAction(io, store, socket, ack, "PLACE_BID", payload, options));
    socket.on("bid:pass", (payload, ack) => handleAction(io, store, socket, ack, "PASS_BID", payload, options));
    socket.on("dutch:stop", (payload, ack) => handleAction(io, store, socket, ack, "DUTCH_STOP", payload, options));
    socket.on("sealedBid:submit", (payload, ack) => handleAction(io, store, socket, ack, "SUBMIT_SEALED_BID", payload, options));
    socket.on("card:play", (payload, ack) => handleAction(io, store, socket, ack, "PLAY_CARD", payload, options));
    socket.on("role:skill", (payload, ack) => handleAction(io, store, socket, ack, "USE_ROLE_SKILL", payload, options));
    socket.on("reaction:respond", (payload, ack) => handleAction(io, store, socket, ack, "RESPOND_REACTION", payload, options));
    socket.on("trade:offer", (payload, ack) => handleAction(io, store, socket, ack, "CREATE_TRADE_OFFER", payload, options));
    socket.on("trade:respond", (payload, ack) => handleAction(io, store, socket, ack, "RESPOND_TRADE_OFFER", payload, options));
    socket.on("bank:sell", (payload, ack) => handleAction(io, store, socket, ack, "SELL_TO_BANK", payload, options));
    socket.on("loan:take", (payload, ack) => handleAction(io, store, socket, ack, "TAKE_LOAN", payload, options));
    socket.on("loan:repay", (payload, ack) => handleAction(io, store, socket, ack, "REPAY_LOAN", payload, options));
    socket.on("room:transferOwner", (payload, ack) => handleAction(io, store, socket, ack, "TRANSFER_OWNER", payload, options));
    socket.on("room:kick", (payload, ack) => handleAction(io, store, socket, ack, "KICK_PLAYER", payload, options));
    socket.on("room:setTimeouts", (payload, ack) => handleAction(io, store, socket, ack, "SET_PHASE_TIMEOUTS", payload, options));
    socket.on("room:setPaused", (payload, ack) => handleAction(io, store, socket, ack, "SET_PAUSED", payload, options));
    socket.on("room:close", (_payload, ack) => {
      safeAck(ack, () => {
        const data = socket.data as SocketData;
        if (!data.roomId || !data.playerId) throw new RuleError("请先加入房间。");
        closeRoom(io, store, data.roomId, data.playerId);
        return {};
      });
    });

    socket.on("disconnect", () => {
      const data = socket.data as SocketData;
      if (!data.roomId || !data.playerId) return;
      try {
        const room = store.rooms.get(data.roomId);
        const player = room?.players.find((candidate) => candidate.id === data.playerId);
        if (player?.kicked) return;
        updateRoom(io, store, data.roomId, {
          type: "SET_CONNECTED",
          playerId: data.playerId,
          payload: { connected: false }
        });
        scheduleOfflineAutomation(io, store, data.roomId, data.playerId);
      } catch {
        // Ignore disconnect races during tests and server shutdown.
      }
    });
  });
}

function offlineTimerKey(roomId: RoomId, playerId: PlayerId): string {
  return `${roomId}:${playerId}`;
}

function scheduleOfflineAutomation(io: GameServer, store: RoomStore, roomId: RoomId, playerId: PlayerId): void {
  clearOfflineAutomation(store, roomId, playerId);
  const timeoutMs = Number(process.env.AUCTIONEER_OFFLINE_AUTOPLAY_MS ?? 45_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return;
  const room = store.rooms.get(roomId);
  const player = room?.players.find((candidate) => candidate.id === playerId);
  const disconnectedAt = player?.disconnectedAt ?? Date.now();
  const elapsed = Math.max(0, Date.now() - disconnectedAt);
  const delay = Math.max(0, timeoutMs - elapsed);
  const timer = setTimeout(() => drainOfflineAutomation(io, store, roomId, playerId), delay);
  timer.unref?.();
  store.offlineTimers.set(offlineTimerKey(roomId, playerId), timer);
}

function clearOfflineAutomation(store: RoomStore, roomId: RoomId, playerId: PlayerId): void {
  const key = offlineTimerKey(roomId, playerId);
  const timer = store.offlineTimers.get(key);
  if (timer) clearTimeout(timer);
  store.offlineTimers.delete(key);
}

function drainOfflineAutomation(io: GameServer, store: RoomStore, roomId: RoomId, playerId: PlayerId): void {
  clearOfflineAutomation(store, roomId, playerId);
  for (let index = 0; index < 8; index += 1) {
    try {
      updateRoom(io, store, roomId, {
        type: "AUTO_ADVANCE_OFFLINE",
        playerId,
        payload: {}
      });
    } catch {
      return;
    }
  }
}

export function schedulePhaseTimeout(io: GameServer, store: RoomStore, roomId: RoomId): void {
  const previous = store.phaseTimers.get(roomId);
  if (previous) clearTimeout(previous);
  store.phaseTimers.delete(roomId);
  const room = store.rooms.get(roomId);
  if (room?.paused) return;
  if (!room?.phaseDeadlineAt) return;
  const delay = Math.max(0, room.phaseDeadlineAt - Date.now());
  const timer = setTimeout(() => runPhaseTimeout(io, store, roomId), delay);
  timer.unref?.();
  store.phaseTimers.set(roomId, timer);
}

export function scheduleRecoveredRoomTimers(io: GameServer, store: RoomStore, roomId: RoomId): void {
  schedulePhaseTimeout(io, store, roomId);
  const room = store.rooms.get(roomId);
  if (!room) return;
  for (const player of room.players) {
    if (!player.connected && !player.kicked) scheduleOfflineAutomation(io, store, roomId, player.id);
  }
}

function runPhaseTimeout(io: GameServer, store: RoomStore, roomId: RoomId): void {
  store.phaseTimers.delete(roomId);
  try {
    const room = requireRoom(store, roomId);
    if (!room.phaseDeadlineAt || Date.now() < room.phaseDeadlineAt) {
      schedulePhaseTimeout(io, store, roomId);
      return;
    }
    const actorId = room.hostPlayerId ?? room.players.find((player) => player.connected && !player.kicked)?.id ?? room.players.find((player) => !player.kicked)?.id;
    if (!actorId) return;
    updateRoom(io, store, roomId, {
      type: "PHASE_TIMEOUT_AUTO",
      playerId: actorId,
      payload: {}
    });
  } catch {
    const retry = setTimeout(() => schedulePhaseTimeout(io, store, roomId), 1000);
    retry.unref?.();
  }
}

function handleAction<T>(
  io: GameServer,
  store: RoomStore,
  socket: GameSocket,
  ack: (response: { ok: true; view: PlayerView } | { ok: false; error: string; code?: RuleErrorCode }) => void,
  type: ServerAction["type"],
  payload: T,
  options: RoomHandlerOptions = {}
): void {
  void safeAckAsync(ack, async () => {
    assertSocketRate(socket, options.rateLimiter, String(type));
    const data = socket.data as SocketData;
    if (!data.roomId || !data.playerId) throw new RuleError("请先加入房间。");
    return enqueueRoomAction(store, data.roomId, () => {
      const room = updateRoom(io, store, data.roomId!, {
        type,
        playerId: data.playerId!,
        payload
      });
      return { view: getPlayerView(room, data.playerId!) };
    });
  });
}

function checkSocketRate(socket: GameSocket, rateLimiter: RateLimiter | undefined, event: string): boolean {
  if (!rateLimiter) return true;
  return rateLimiter.hit(socketRateKey(socket, event), actionRateOptions(event));
}

function assertSocketRate(socket: GameSocket, rateLimiter: RateLimiter | undefined, event: string): void {
  if (!checkSocketRate(socket, rateLimiter, event)) throw new RateLimitError();
}

function updateRoom(io: GameServer, store: RoomStore, roomId: RoomId, action: ServerAction): GameState {
  const room = requireRoom(store, roomId);
  const next = reduceGame(room, action);
  store.rooms.set(roomId, next);
  persistAction(store, roomId, action, next);
  persistSnapshot(store, next);
  broadcastRoom(io, store, roomId);
  if (action.type === "KICK_PLAYER") {
    const targetPlayerId = (action.payload as { playerId?: PlayerId } | undefined)?.playerId;
    if (targetPlayerId) {
      io.to(playerChannel(roomId, targetPlayerId)).emit("room:error", {
        message: "你已被房主移出房间。",
        code: "SESSION_INVALID"
      });
    }
  }
  schedulePhaseTimeout(io, store, roomId);
  return next;
}

function closeRoom(io: GameServer, store: RoomStore, roomId: RoomId, actorId: PlayerId): void {
  const room = requireRoom(store, roomId);
  requirePlayerInRoom(room, actorId);
  const actorName = room.players.find((player) => player.id === actorId)?.nickname ?? "一名玩家";
  const closedRoom: GameState = {
    ...room,
    closedAt: Date.now(),
    closedBy: actorId,
    lastMessage: `${actorName} 退出并关闭了房间。`,
    log: [...room.log, `${actorName} 退出并关闭了房间。`],
    actionIndex: room.actionIndex + 1,
    updatedAt: Date.now()
  };
  persistAction(store, roomId, { type: "CLOSE_ROOM", playerId: actorId, payload: {} }, closedRoom);
  persistSnapshot(store, closedRoom);
  clearPhaseTimer(store, roomId);
  for (const player of room.players) {
    clearOfflineAutomation(store, roomId, player.id);
    io.to(playerChannel(roomId, player.id)).emit("room:error", {
      message: `${actorName} 退出并关闭了房间，需要重新开房。`,
      code: "SESSION_INVALID"
    });
  }
  for (const [token, session] of [...store.sessions.entries()]) {
    if (session.roomId === roomId) store.sessions.delete(token);
  }
  store.rooms.delete(roomId);
  store.joinCodes.delete(room.joinCode);
  store.actionQueues.delete(roomId);
}

function clearPhaseTimer(store: RoomStore, roomId: RoomId): void {
  const timer = store.phaseTimers.get(roomId);
  if (timer) clearTimeout(timer);
  store.phaseTimers.delete(roomId);
}

function requirePlayerInRoom(room: GameState, playerId: PlayerId): void {
  if (!room.players.some((player) => player.id === playerId && !player.kicked)) throw new RuleError("你不在这个房间。", "SESSION_INVALID");
}

function enqueueRoomAction<T>(store: RoomStore, roomId: RoomId, work: () => T): Promise<T> {
  const previous = store.actionQueues.get(roomId) ?? Promise.resolve();
  const next = previous.then(work, work);
  store.actionQueues.set(
    roomId,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

function broadcastRoom(io: GameServer, store: RoomStore, roomId: RoomId): void {
  const room = requireRoom(store, roomId);
  for (const player of room.players) {
    io.to(playerChannel(roomId, player.id)).emit("room:update", getPlayerView(room, player.id));
  }
}

function createSession(store: RoomStore, roomId: RoomId, playerId: PlayerId): string {
  const token = makeId("session");
  const session = { token, roomId, playerId };
  store.sessions.set(token, session);
  store.repository.saveSession(session);
  return token;
}

function loadSession(store: RoomStore, token: string): SessionRecord | undefined {
  const cached = store.sessions.get(token);
  if (cached) return cached;
  const persisted = store.repository.loadSession(token);
  if (!persisted) return undefined;
  const session = { token: persisted.token, roomId: persisted.roomId, playerId: persisted.playerId };
  store.sessions.set(token, session);
  return session;
}

function attachSocket(socket: GameSocket, roomId: RoomId, playerId: PlayerId, token: string): void {
  const data = socket.data as SocketData;
  data.roomId = roomId;
  data.playerId = playerId;
  data.token = token;
}

function playerChannel(roomId: RoomId, playerId: PlayerId): string {
  return `${roomId}:player:${playerId}`;
}

function requireRoom(store: RoomStore, roomId: RoomId): GameState {
  const room = store.rooms.get(roomId) ?? restoreRoomIntoStore(store, roomId);
  if (!room) throw new RuleError("房间不存在。");
  return room;
}

function persistAction(store: RoomStore, roomId: RoomId, action: ServerAction, next: GameState): void {
  const log: ActionLog = {
    actionIndex: next.actionIndex,
    actionId: action.actionId ?? makeId("action"),
    roomId,
    actorId: action.playerId,
    type: action.type,
    payload: action.payload,
    resultSummary: next.lastMessage ?? action.type,
    createdAt: next.updatedAt
  };
  store.repository.appendAction(log);
}

function persistSnapshot(store: RoomStore, state: GameState): void {
  store.repository.saveSnapshot(snapshotFromState(state));
}

function safeAck<T>(ack: (response: ({ ok: true } & T) | { ok: false; error: string; code?: RuleErrorCode }) => void, work: () => T): void {
  try {
    ack({ ok: true, ...work() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误。";
    const code = error instanceof RateLimitError ? "RATE_LIMITED" : error instanceof RuleError ? (error.code as RuleErrorCode) : undefined;
    ack({ ok: false, error: message, code });
  }
}

async function safeAckAsync<T>(
  ack: (response: ({ ok: true } & T) | { ok: false; error: string; code?: RuleErrorCode }) => void,
  work: () => Promise<T>
): Promise<void> {
  try {
    ack({ ok: true, ...(await work()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误。";
    const code = error instanceof RateLimitError ? "RATE_LIMITED" : error instanceof RuleError ? (error.code as RuleErrorCode) : undefined;
    ack({ ok: false, error: message, code });
  }
}
