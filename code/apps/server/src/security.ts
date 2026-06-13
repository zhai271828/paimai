import type { FastifyRequest } from "fastify";
import type { Socket } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@auctioneer/shared";

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

interface RateLimitBucket {
  windowStartedAt: number;
  count: number;
}

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
}

export interface RateLimiter {
  assert(key: string, options?: RateLimitOptions): void;
  hit(key: string, options?: RateLimitOptions): boolean;
}

const DEFAULT_WINDOW_MS = readPositiveInt("AUCTIONEER_RATE_LIMIT_WINDOW_MS", 60_000);
const DEFAULT_MAX = readPositiveInt("AUCTIONEER_RATE_LIMIT_MAX", 240);

export function createRateLimiter(): RateLimiter {
  const buckets = new Map<string, RateLimitBucket>();
  return {
    assert(key, options) {
      if (!this.hit(key, options)) throw new RateLimitError();
    },
    hit(key, options = {}) {
      const now = Date.now();
      const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
      const max = options.max ?? DEFAULT_MAX;
      const existing = buckets.get(key);
      if (!existing || now - existing.windowStartedAt >= windowMs) {
        buckets.set(key, { windowStartedAt: now, count: 1 });
        pruneBuckets(buckets, now, windowMs);
        return true;
      }
      existing.count += 1;
      return existing.count <= max;
    }
  };
}

export class RateLimitError extends Error {
  readonly code = "RATE_LIMITED";

  constructor(message = "操作过于频繁，请稍后再试。") {
    super(message);
    this.name = "RateLimitError";
  }
}

export function resolveAllowedOrigins(): string[] {
  const configured = splitEnvList(process.env.AUCTIONEER_ALLOWED_ORIGINS);
  if (configured.length > 0) return configured;
  if (process.env.NODE_ENV === "production") return [];
  return ["http://localhost:5173", "http://127.0.0.1:5173"];
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins = resolveAllowedOrigins()): boolean {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

export function corsOriginHandler(allowedOrigins = resolveAllowedOrigins()) {
  return (origin: string | undefined, callback: (error: Error | null, allow: boolean) => void): void => {
    callback(null, isOriginAllowed(origin, allowedOrigins));
  };
}

export function socketOriginAllowed(socket: GameSocket, allowedOrigins = resolveAllowedOrigins()): boolean {
  const origin = socket.handshake.headers.origin;
  return isOriginAllowed(Array.isArray(origin) ? origin[0] : origin, allowedOrigins);
}

export function requestRateKey(request: FastifyRequest): string {
  return `http:${request.ip}`;
}

export function socketRateKey(socket: GameSocket, scope: string): string {
  const address = socket.handshake.address || "unknown";
  return `socket:${scope}:${address}`;
}

export function actionRateOptions(event: string): RateLimitOptions {
  if (event === "room:create") return { windowMs: 60_000, max: readPositiveInt("AUCTIONEER_CREATE_ROOM_LIMIT", 20) };
  if (event === "room:join") return { windowMs: 60_000, max: readPositiveInt("AUCTIONEER_JOIN_ROOM_LIMIT", 60) };
  if (event === "room:resume") return { windowMs: 60_000, max: readPositiveInt("AUCTIONEER_RESUME_LIMIT", 120) };
  return { windowMs: 10_000, max: readPositiveInt("AUCTIONEER_SOCKET_ACTION_LIMIT", 80) };
}

function pruneBuckets(buckets: Map<string, RateLimitBucket>, now: number, fallbackWindowMs: number): void {
  if (buckets.size < 10_000) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStartedAt > fallbackWindowMs * 2) buckets.delete(key);
  }
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readPositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
