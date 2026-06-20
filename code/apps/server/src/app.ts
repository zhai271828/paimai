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
      setHeaders: (res, filePath) => {
        if (path.basename(filePath) === "index.html") {
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        }
      }
    });
    app.setNotFoundHandler((request, reply) => {
      if (!shouldServeSpaFallback(request)) {
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

function shouldServeSpaFallback(request: { method: string; url: string; headers: { accept?: string } }): boolean {
  if (request.method !== "GET") return false;

  const pathname = request.url.split("?")[0] ?? request.url;
  if (pathname.startsWith("/socket.io/") || pathname.startsWith("/health")) return false;
  if (path.extname(pathname)) return false;

  return request.headers.accept?.includes("text/html") ?? false;
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
