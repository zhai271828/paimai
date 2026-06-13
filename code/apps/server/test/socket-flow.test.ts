import { io as createClient, type Socket } from "socket.io-client";
import { createApp } from "../src/app";
import type { ClientToServerEvents, PlayerView, ServerToClientEvents } from "@auctioneer/shared";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface ClientSeat {
  socket: ClientSocket;
  view: PlayerView;
  token: string;
}

const { app, io } = await createApp();
process.env.AUCTIONEER_OFFLINE_AUTOPLAY_MS = "20";
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Unable to resolve test server address.");
const url = `http://127.0.0.1:${address.port}`;

try {
  const p1 = await createRoom("A");
  const p2 = await joinRoom(p1.view.joinCode, "B");
  const p3 = await joinRoom(p1.view.joinCode, "C");
  const p4 = await joinRoom(p1.view.joinCode, "D");
  const players = [p1, p2, p3, p4];

  for (const player of players) {
    player.socket.on("room:update", (view) => {
      player.view = view;
    });
  }

  await emit(p1, "player:ready", { ready: true });
  await emit(p2, "player:ready", { ready: true });
  await emit(p3, "player:ready", { ready: true });
  await emit(p4, "player:ready", { ready: true });
  await emit(p1, "room:start", {});
  await emit(p1, "phase:advance", {});

  if (p1.view.phase !== "preview") throw new Error(`Expected preview, got ${p1.view.phase}`);
  await expectEmitError(p1.socket, "host:setAuction", { mode: "sealed", startingBid: 0 }, "系统随机");
  p1.socket.disconnect();
  await wait(60);
  if (p2.view.players.find((player) => player.id === p1.view.selfId)?.connected !== false) throw new Error("Disconnected host should be visible as offline.");
  if (p2.view.currentHostId !== undefined) throw new Error("Current day should switch to system host after host disconnects before auction.");
  if (!p2.view.canAdvance) throw new Error("New room owner should be able to advance a system-hosted day.");
  await emit(p2, "phase:advance", {});
  if (p2.view.phase !== "cardWindow") throw new Error(`Expected system auction card window, got ${p2.view.phase}`);
  const resumedP1 = await resumeRoom(p1.view.roomId, p1.view.selfId, p1.token);
  resumedP1.socket.on("room:update", (view) => {
    resumedP1.view = view;
  });
  players[0] = resumedP1;
  await wait(60);
  if (resumedP1.view.self.connected !== true) throw new Error("Resumed host should be connected again.");
  await emit(p2, "phase:advance", {});
  if (phaseOf(p2) !== "auction") throw new Error(`Expected auction after resumed flow, got ${p2.view.phase}`);

  await resolveCurrentAuction(players, 80);
  if (phaseOf(p2) !== "settlement") throw new Error(`Expected settlement after reconnect auction, got ${p2.view.phase}`);

  for (const player of players) player.socket.disconnect();

  const adminA = await createRoom("OwnerA");
  const adminB = await joinRoom(adminA.view.joinCode, "OwnerB");
  const adminC = await joinRoom(adminA.view.joinCode, "OwnerC");
  for (const player of [adminA, adminB, adminC]) {
    player.socket.on("room:update", (view) => {
      player.view = view;
    });
  }
  await emit(adminA, "room:transferOwner", { playerId: adminB.view.selfId });
  if (!adminB.view.canManageRoom) throw new Error("Transferred owner should be able to manage the room.");
  const kickNotice = waitForRoomError(adminC.socket);
  await emit(adminB, "room:kick", { playerId: adminC.view.selfId });
  const notice = await kickNotice;
  if (notice.code !== "SESSION_INVALID") throw new Error(`Expected kicked player session error, got ${notice.code}.`);
  await expectEmitError(adminC.socket, "room:resume", {
    roomId: adminC.view.roomId,
    playerId: adminC.view.selfId,
    sessionToken: adminC.token
  }, "移出房间");
  await emit(adminA, "player:ready", { ready: true });
  await emit(adminB, "player:ready", { ready: true });
  await expectEmitError(adminB.socket, "room:start", {}, "至少需要");
  adminA.socket.disconnect();
  adminB.socket.disconnect();
  adminC.socket.disconnect();

  const closeA = await createRoom("CloseA");
  const closeB = await joinRoom(closeA.view.joinCode, "CloseB");
  const closedNotice = waitForRoomError(closeB.socket);
  const closeResponse = await emitRaw<{}>(closeA.socket, "room:close", {});
  if (!closeResponse) throw new Error("Close room should ack.");
  const closedPayload = await closedNotice;
  if (closedPayload.code !== "SESSION_INVALID") throw new Error(`Expected close notice session error, got ${closedPayload.code}.`);
  await expectEmitError(closeB.socket, "room:resume", {
    roomId: closeB.view.roomId,
    playerId: closeB.view.selfId,
    sessionToken: closeB.token
  }, "房间不存在");
  await expectEmitError(closeB.socket, "room:join", { joinCode: closeA.view.joinCode, nickname: "Late" }, "房间不存在");
  closeA.socket.disconnect();
  closeB.socket.disconnect();

  const timedA = await createRoom("TimedA");
  const timedB = await joinRoom(timedA.view.joinCode, "TimedB");
  const timedC = await joinRoom(timedA.view.joinCode, "TimedC");
  const timedD = await joinRoom(timedA.view.joinCode, "TimedD");
  const timedPlayers = [timedA, timedB, timedC, timedD];
  for (const player of timedPlayers) {
    player.socket.on("room:update", (view) => {
      player.view = view;
    });
  }
  await emit(timedA, "room:setTimeouts", { timeouts: { dayIncome: 20, preview: 20, cardWindow: 20 } });
  await emit(timedA, "player:ready", { ready: true });
  await emit(timedB, "player:ready", { ready: true });
  await emit(timedC, "player:ready", { ready: true });
  await emit(timedD, "player:ready", { ready: true });
  await emit(timedA, "room:start", {});
  await waitForPhase(timedA, "auction", 1500);
  timedPlayers.forEach((player) => player.socket.disconnect());

  console.log("socket-flow ok");
} finally {
  await io.close();
  await app.close();
}

async function createRoom(nickname: string): Promise<ClientSeat> {
  const socket = createClient(url, { transports: ["websocket"] }) as ClientSocket;
  await waitForConnect(socket);
  const response = await emitRaw<{ view: PlayerView; sessionToken: string }>(socket, "room:create", { nickname });
  return { socket, view: response.view, token: response.sessionToken };
}

async function joinRoom(joinCode: string, nickname: string): Promise<ClientSeat> {
  const socket = createClient(url, { transports: ["websocket"] }) as ClientSocket;
  await waitForConnect(socket);
  const response = await emitRaw<{ view: PlayerView; sessionToken: string }>(socket, "room:join", { joinCode, nickname });
  return { socket, view: response.view, token: response.sessionToken };
}

async function resumeRoom(roomId: string, playerId: string, sessionToken: string): Promise<ClientSeat> {
  const socket = createClient(url, { transports: ["websocket"] }) as ClientSocket;
  await waitForConnect(socket);
  const response = await emitRaw<{ view: PlayerView }>(socket, "room:resume", { roomId, playerId, sessionToken });
  return { socket, view: response.view, token: sessionToken };
}

function phaseOf(seat: ClientSeat): PlayerView["phase"] {
  return seat.view.phase;
}

async function emit<T>(seat: ClientSeat, event: keyof ClientToServerEvents, payload: unknown): Promise<T> {
  const response = await emitRaw<T & { view?: PlayerView }>(seat.socket, event, payload);
  if (response.view) seat.view = response.view;
  await wait(20);
  return response;
}

async function emitRaw<T>(socket: ClientSocket, event: keyof ClientToServerEvents, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    (socket.emit as unknown as (event: string, payload: unknown, ack: (response: ({ ok: true } & T) | { ok: false; error: string }) => void) => void)(
      event,
      payload,
      (response) => {
      if (!response.ok) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
      }
    );
  });
}

async function expectEmitError(socket: ClientSocket, event: keyof ClientToServerEvents, payload: unknown, message: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    (socket.emit as unknown as (event: string, payload: unknown, ack: (response: { ok: true } | { ok: false; error: string }) => void) => void)(
      event,
      payload,
      (response) => {
        if (response.ok) {
          reject(new Error(`Expected ${event} to fail.`));
          return;
        }
        if (!response.error.includes(message)) {
          reject(new Error(`Expected ${event} error to include ${message}, got ${response.error}.`));
          return;
        }
        resolve();
      }
    );
  });
}

async function waitForRoomError(socket: ClientSocket): Promise<{ message: string; code?: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("room:error timeout.")), 1000);
    socket.once("room:error", (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

async function waitForPhase(seat: ClientSeat, phase: PlayerView["phase"], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (seat.view.phase === phase) return;
    await wait(20);
  }
  throw new Error(`Expected phase ${phase}, got ${seat.view.phase}.`);
}

async function resolveCurrentAuction(seats: ClientSeat[], bidAmount: number): Promise<void> {
  const view = seats.find((seat) => seat.view.phase === "auction")?.view ?? seats[0]!.view;
  const mode = view.auction?.mode === "bundle" ? view.auction.bundleInnerMode ?? "english" : view.auction?.mode;
  const bidders = seats.filter((seat) => seat.view.selfId !== view.currentHostId);
  if (mode === "english") {
    await emit(bidders[0]!, "bid:place", { amount: bidAmount });
    for (const bidder of bidders.slice(1)) {
      if (bidder.view.phase === "auction") await emit(bidder, "bid:pass", {});
    }
    return;
  }
  if (mode === "dutch") {
    await emit(bidders[0]!, "dutch:stop", {});
    return;
  }
  for (const [index, bidder] of bidders.entries()) {
    if (bidder.view.phase === "auction") await emit(bidder, "sealedBid:submit", { amount: Math.max(0, bidAmount - index * 10) });
  }
}

async function waitForConnect(socket: ClientSocket): Promise<void> {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket connection timeout.")), 2000);
    socket.on("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
