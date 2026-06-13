import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@auctioneer/shared";
import { createRoomStore, registerRoomHandlers, restorePersistedRoomsIntoStore, scheduleRecoveredRoomTimers, type RoomStore } from "./rooms.js";
import type { RoomRepository } from "./persistence.js";
import { corsOriginHandler, createRateLimiter, requestRateKey, resolveAllowedOrigins } from "./security.js";

export interface AppBundle {
  app: ReturnType<typeof Fastify>;
  io: Server<ClientToServerEvents, ServerToClientEvents>;
  store: RoomStore;
}

export async function createApp(repository?: RoomRepository): Promise<AppBundle> {
  const allowedOrigins = resolveAllowedOrigins();
  const rateLimiter = createRateLimiter();
  const app = Fastify({ logger: process.env.NODE_ENV === "production" });
  await app.register(cors, {
    origin: corsOriginHandler(allowedOrigins),
    credentials: true
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    if (!rateLimiter.hit(requestRateKey(request), { windowMs: 60_000, max: 300 })) {
      return reply.code(429).send({ ok: false, error: "请求过于频繁，请稍后再试。" });
    }
  });

  app.get("/health", async () => ({ ok: true, service: "auctioneer-server" }));

  const staticRoot = resolveStaticRoot();
  if (staticRoot) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: "/",
      wildcard: false
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET" || request.url.startsWith("/socket.io/") || request.url.startsWith("/health")) {
        return reply.code(404).send({ ok: false, error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  const io = new Server<ClientToServerEvents, ServerToClientEvents>(app.server, {
    cors: {
      origin: corsOriginHandler(allowedOrigins),
      credentials: true
    }
  });
  const store = createRoomStore(repository);
  registerRoomHandlers(io, store, { allowedOrigins, rateLimiter });
  for (const room of restorePersistedRoomsIntoStore(store)) scheduleRecoveredRoomTimers(io, store, room.roomId);
  return { app, io, store };
}

function resolveStaticRoot(): string | undefined {
  const configured = process.env.AUCTIONEER_STATIC_DIR;
  const candidates = [
    configured,
    path.resolve(process.cwd(), "apps/web/dist"),
    path.resolve(process.cwd(), "../web/dist"),
    path.resolve(process.cwd(), "../../apps/web/dist")
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html")));
}
