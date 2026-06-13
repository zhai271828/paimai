import { io as createClient, type Socket } from "socket.io-client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuctionMode, ClientToServerEvents, PlayerView, ServerToClientEvents } from "@auctioneer/shared";
import { createApp, type AppBundle } from "../src/app";
import { InMemoryRoomRepository, JsonFileRoomRepository, SqliteRoomRepository, type RoomRepository } from "../src/persistence";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type BidMode = Exclude<AuctionMode, "bundle">;

interface ClientSeat {
  socket: ClientSocket;
  view: PlayerView;
  token: string;
}

const repository = new InMemoryRoomRepository();
const firstApp = await startApp(repository);

try {
  const [p1, p2, p3, p4] = await createRoomWithBidMode(firstApp.url, "sealed", "R");
  const players = [p1, p2, p3, p4];
  await emit(p2, "sealedBid:submit", { amount: 70 });

  const roomId = p1.view.roomId;
  const p2Id = p2.view.selfId;
  const p2Token = p2.token;
  if (!repository.loadLatestSnapshot(roomId)) throw new Error("Expected a persisted room snapshot.");
  if (repository.listActionsAfter(roomId, 0).length < 7) throw new Error("Expected action log entries after gameplay.");

  for (const player of [p1, p3, p4]) player.socket.disconnect();
  p2.socket.disconnect();
  await firstApp.io.close();
  await firstApp.app.close();

  const secondApp = await startApp(repository);
  try {
    const resumed = await resumeRoom(secondApp.url, roomId, p2Id, p2Token);
    if (resumed.view.phase !== "auction") throw new Error(`Expected recovered auction phase, got ${resumed.view.phase}.`);
    if (resumed.view.selfId !== p2Id) throw new Error("Recovered view belongs to the wrong player.");
    if (resumed.view.auction?.ownSealedBid !== 70) throw new Error("Recovered private sealed bid was lost.");
    if (resumed.view.auction?.visibleSealedBids) throw new Error("Recovered non-gambler view leaked other sealed bids.");
    if (resumed.view.todayArtifacts.some((artifact) => artifact.trueValue !== undefined || artifact.properties !== undefined || artifact.tag !== undefined)) {
      throw new Error("Recovered public auction view leaked hidden artifact data.");
    }
    resumed.socket.disconnect();
    console.log("recovery ok");
  } finally {
    await secondApp.io.close();
    await secondApp.app.close();
  }
} finally {
  try {
    await firstApp.io.close();
    await firstApp.app.close();
  } catch {
    // The first app may already be closed after the restart simulation.
  }
}

const tempDir = mkdtempSync(join(tmpdir(), "auctioneer-recovery-"));
try {
  const fileRepository = new JsonFileRoomRepository(tempDir);
  const appWithFileRepo = await startApp(fileRepository);
  const p1 = await createRoom(appWithFileRepo.url, "FileA");
  const roomId = p1.view.roomId;
  const playerId = p1.view.selfId;
  const token = p1.token;
  p1.socket.disconnect();
  await appWithFileRepo.io.close();
  await appWithFileRepo.app.close();

  const coldRepository = new JsonFileRoomRepository(tempDir);
  if (!coldRepository.loadSession(token)) throw new Error("Expected session to survive repository cold start.");
  if (!coldRepository.loadLatestSnapshot(roomId)) throw new Error("Expected snapshot to survive repository cold start.");
  const coldApp = await startApp(coldRepository);
  try {
    const resumed = await resumeRoom(coldApp.url, roomId, playerId, token);
    if (resumed.view.selfId !== playerId) throw new Error("Cold-start file repository resumed the wrong player.");
    resumed.socket.disconnect();
    console.log("file-recovery ok");
  } finally {
    await coldApp.io.close();
    await coldApp.app.close();
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const sqliteDir = mkdtempSync(join(tmpdir(), "auctioneer-sqlite-recovery-"));
try {
  const sqlitePath = join(sqliteDir, "rooms.sqlite");
  const sqliteRepository = new SqliteRoomRepository(sqlitePath);
  const appWithSqliteRepo = await startApp(sqliteRepository);
  const p1 = await createRoom(appWithSqliteRepo.url, "SqliteA");
  const roomId = p1.view.roomId;
  const playerId = p1.view.selfId;
  const token = p1.token;
  p1.socket.disconnect();
  await appWithSqliteRepo.io.close();
  await appWithSqliteRepo.app.close();
  sqliteRepository.close();

  const coldRepository = new SqliteRoomRepository(sqlitePath);
  if (!coldRepository.loadSession(token)) throw new Error("Expected SQLite session to survive repository cold start.");
  if (!coldRepository.loadLatestSnapshot(roomId)) throw new Error("Expected SQLite snapshot to survive repository cold start.");
  const coldApp = await startApp(coldRepository);
  try {
    const resumed = await resumeRoom(coldApp.url, roomId, playerId, token);
    if (resumed.view.selfId !== playerId) throw new Error("Cold-start SQLite repository resumed the wrong player.");
    resumed.socket.disconnect();
    console.log("sqlite-recovery ok");
  } finally {
    await coldApp.io.close();
    await coldApp.app.close();
    coldRepository.close();
  }
} finally {
  rmSync(sqliteDir, { recursive: true, force: true });
}

const compensationRepository = new InMemoryRoomRepository();
process.env.AUCTIONEER_OFFLINE_AUTOPLAY_MS = "1000";
const compensationApp = await startApp(compensationRepository);
try {
  const [p1, p2, p3, p4] = await createRoomWithBidMode(compensationApp.url, "sealed", "Comp");
  const players = [p1, p2, p3, p4];
  p3.socket.disconnect();
  await wait(40);
  const snapshot = compensationRepository.loadLatestSnapshot(p1.view.roomId);
  if (!snapshot?.state.players.find((player) => player.id === p3.view.selfId)?.disconnectedAt) {
    throw new Error("Expected disconnectedAt to persist before compensation restart.");
  }
  for (const player of [p1, p2, p4]) player.socket.disconnect();
  await compensationApp.io.close();
  await compensationApp.app.close();

  process.env.AUCTIONEER_OFFLINE_AUTOPLAY_MS = "20";
  const restarted = await startApp(compensationRepository);
  try {
    await wait(120);
    const resumed = await resumeRoom(restarted.url, p1.view.roomId, p3.view.selfId, p3.token);
    if (resumed.view.auction?.ownSealedBid !== 0) throw new Error("Recovered server did not compensate missed offline sealed bid.");
    if (!resumed.view.self.automatedReason?.includes("暗标")) throw new Error("Recovered player did not receive automation reason.");
    resumed.socket.disconnect();
    console.log("compensation-recovery ok");
  } finally {
    await restarted.io.close();
    await restarted.app.close();
  }
} finally {
  try {
    await compensationApp.io.close();
    await compensationApp.app.close();
  } catch {
    // The compensation app may already be closed after restart simulation.
  }
}

async function startApp(repository: RoomRepository): Promise<AppBundle & { url: string }> {
  const bundle = await createApp(repository);
  await bundle.app.listen({ port: 0, host: "127.0.0.1" });
  const address = bundle.app.server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve test server address.");
  return { ...bundle, url: `http://127.0.0.1:${address.port}` };
}

async function createRoom(url: string, nickname: string): Promise<ClientSeat> {
  const socket = createClient(url, { transports: ["websocket"] }) as ClientSocket;
  await waitForConnect(socket);
  const response = await emitRaw<{ view: PlayerView; sessionToken: string }>(socket, "room:create", { nickname });
  return { socket, view: response.view, token: response.sessionToken };
}

async function joinRoom(url: string, joinCode: string, nickname: string): Promise<ClientSeat> {
  const socket = createClient(url, { transports: ["websocket"] }) as ClientSocket;
  await waitForConnect(socket);
  const response = await emitRaw<{ view: PlayerView; sessionToken: string }>(socket, "room:join", { joinCode, nickname });
  return { socket, view: response.view, token: response.sessionToken };
}

async function createRoomWithBidMode(url: string, wantedMode: BidMode, prefix: string): Promise<[ClientSeat, ClientSeat, ClientSeat, ClientSeat]> {
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const p1 = await createRoom(url, `${prefix}A${attempt}`);
    const p2 = await joinRoom(url, p1.view.joinCode, `${prefix}B${attempt}`);
    const p3 = await joinRoom(url, p1.view.joinCode, `${prefix}C${attempt}`);
    const p4 = await joinRoom(url, p1.view.joinCode, `${prefix}D${attempt}`);
    const seats = [p1, p2, p3, p4] as [ClientSeat, ClientSeat, ClientSeat, ClientSeat];
    for (const player of seats) bindUpdates(player);

    await emit(p1, "player:ready", { ready: true });
    await emit(p2, "player:ready", { ready: true });
    await emit(p3, "player:ready", { ready: true });
    await emit(p4, "player:ready", { ready: true });
    await emit(p1, "room:start", {});
    await emit(p1, "phase:advance", {});
    await emit(p1, "phase:advance", {});
    await emit(p2, "phase:advance", {});

    const mode = bidMode(p2.view);
    if (p2.view.phase === "auction" && mode === wantedMode) return seats;
    for (const seat of seats) seat.socket.disconnect();
  }
  throw new Error(`Unable to create random ${wantedMode} auction room.`);
}

async function resumeRoom(url: string, roomId: string, playerId: string, sessionToken: string): Promise<ClientSeat> {
  const socket = createClient(url, { transports: ["websocket"] }) as ClientSocket;
  await waitForConnect(socket);
  const response = await emitRaw<{ view: PlayerView }>(socket, "room:resume", { roomId, playerId, sessionToken });
  return { socket, view: response.view, token: sessionToken };
}

function bidMode(view: PlayerView): BidMode | undefined {
  if (!view.auction) return undefined;
  return view.auction.mode === "bundle" ? view.auction.bundleInnerMode ?? "english" : view.auction.mode;
}

function bindUpdates(seat: ClientSeat): void {
  seat.socket.on("room:update", (view) => {
    seat.view = view;
  });
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
