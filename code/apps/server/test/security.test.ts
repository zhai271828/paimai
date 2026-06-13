import { io as createClient, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@auctioneer/shared";
import { createApp } from "../src/app";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const originalEnv = {
  allowedOrigins: process.env.AUCTIONEER_ALLOWED_ORIGINS,
  createLimit: process.env.AUCTIONEER_CREATE_ROOM_LIMIT,
  nodeEnv: process.env.NODE_ENV
};

try {
  process.env.NODE_ENV = "production";
  delete process.env.AUCTIONEER_ALLOWED_ORIGINS;
  const closedApp = await createApp();
  const closedResponse = await closedApp.app.inject({
    method: "OPTIONS",
    url: "/health",
    headers: {
      origin: "https://evil.example",
      "access-control-request-method": "GET"
    }
  });
  if (closedResponse.headers["access-control-allow-origin"]) throw new Error("Production CORS should deny unconfigured origins.");
  await closedApp.io.close();
  await closedApp.app.close();

  process.env.NODE_ENV = "test";
  process.env.AUCTIONEER_ALLOWED_ORIGINS = "https://game.example";
  process.env.AUCTIONEER_CREATE_ROOM_LIMIT = "1";
  const limitedApp = await createApp();
  await limitedApp.app.listen({ port: 0, host: "127.0.0.1" });
  const address = limitedApp.app.server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve test server address.");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const socket = createClient(url, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: { origin: "https://game.example" }
    }) as ClientSocket;
    await waitForConnect(socket);
    const first = await emitRaw<{ sessionToken: string }>(socket, "room:create", { nickname: "A" });
    if (!first.ok) throw new Error(`First room:create should pass, got ${first.error}.`);
    const second = await emitRaw(socket, "room:create", { nickname: "B" });
    if (second.ok || second.code !== "RATE_LIMITED") throw new Error("Second room:create should be rate limited.");
    socket.disconnect();
  } finally {
    await limitedApp.io.close();
    await limitedApp.app.close();
  }
  console.log("security ok");
} finally {
  restoreEnv();
}

function emitRaw<T>(
  socket: ClientSocket,
  event: keyof ClientToServerEvents,
  payload: unknown
): Promise<({ ok: true } & T) | { ok: false; error: string; code?: string }> {
  return new Promise((resolve) => {
    (socket.emit as unknown as (
      event: string,
      payload: unknown,
      ack: (response: ({ ok: true } & T) | { ok: false; error: string; code?: string }) => void
    ) => void)(event, payload, resolve);
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
    socket.on("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function restoreEnv(): void {
  setOrDeleteEnv("AUCTIONEER_ALLOWED_ORIGINS", originalEnv.allowedOrigins);
  setOrDeleteEnv("AUCTIONEER_CREATE_ROOM_LIMIT", originalEnv.createLimit);
  setOrDeleteEnv("NODE_ENV", originalEnv.nodeEnv);
}

function setOrDeleteEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
