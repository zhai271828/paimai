import { io as createClient, type Socket } from "socket.io-client";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { AuctionMode, ClientToServerEvents, GameState, PlayerView, ServerToClientEvents } from "@auctioneer/shared";
import { createApp, type AppBundle } from "../src/app";
import { InMemoryRoomRepository, JsonFileRoomRepository, type RoomRepository } from "../src/persistence";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type AckResponse<T> = ({ ok: true } & T) | { ok: false; error: string; code?: string };
type BidMode = Exclude<AuctionMode, "bundle">;

interface ClientSeat {
  socket: ClientSocket;
  view: PlayerView;
  token: string;
  seatIndex: number;
}

interface MetricRecord {
  scenario: string;
  event: string;
  ms: number;
  ok: boolean;
  expectedRuleError?: boolean;
  error?: string;
}

interface StressScenarioSummary {
  scenario: string;
  rooms: number;
  sockets: number;
  actions: number;
  okActions: number;
  expectedRuleErrors: number;
  unexpectedErrors: number;
  totalMs: number;
  ack: LatencyStats;
  byEvent: Record<string, LatencyStats & { count: number; errors: number }>;
  memoryBeforeMb: number;
  memoryAfterMb: number;
}

interface StressScenarioFailure {
  scenario: string;
  rooms: number;
  sockets: number;
  actions: number;
  okActions: number;
  expectedRuleErrors: number;
  unexpectedErrors: number;
  totalMs: number;
  ack: LatencyStats;
  byEvent: Record<string, LatencyStats & { count: number; errors: number }>;
  memoryBeforeMb: number;
  memoryAfterMb: number;
  error: string;
}

interface StressScenarioConfig {
  kind: "sealed" | "dutch" | "recovery";
  label: string;
  rooms: number;
  concurrency: number;
}

interface StressScale {
  name: string;
  scenarios: StressScenarioConfig[];
}

interface ScenarioRuntime {
  metrics: MetricRecord[];
  memoryBefore: number;
  started: number;
}

interface LatencyStats {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const outputDir = join(process.cwd(), "output", "stress");
mkdirSync(outputDir, { recursive: true });

const stressScale = readScale();
const ackTimeoutMs = readPositiveInt("STRESS_ACK_TIMEOUT_MS", 30_000);
const connectTimeoutMs = readPositiveInt("STRESS_CONNECT_TIMEOUT_MS", 20_000);
const stateTimeoutMs = readPositiveInt("STRESS_STATE_TIMEOUT_MS", 8_000);
const suiteStartedAt = new Date().toISOString();
const scenarioSummaries: StressScenarioSummary[] = [];
const scenarioFailures: StressScenarioFailure[] = [];

for (const scenario of stressScale.scenarios) {
  const result = await runScenarioSafely(scenario);
  if ("error" in result) scenarioFailures.push(result);
  else scenarioSummaries.push(result);
}

const report = {
  ok: scenarioFailures.length === 0,
  startedAt: suiteStartedAt,
  finishedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    transport: "socket.io websocket on local loopback",
    scale: stressScale.name,
    ackTimeoutMs,
    connectTimeoutMs,
    stateTimeoutMs,
    note: "本脚本直接压测 Socket ack 延迟，不包含浏览器渲染耗时。"
  },
  scenarios: scenarioSummaries,
  failures: scenarioFailures
};

writeFileSync(join(outputDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(join(outputDir, `stress-${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`${report.ok ? "stress ok" : "stress failed"} ${join(outputDir, "latest.json")}`);
if (!report.ok) process.exitCode = 1;

async function runScenarioSafely(config: StressScenarioConfig): Promise<StressScenarioSummary | StressScenarioFailure> {
  const runtime: ScenarioRuntime = {
    metrics: [],
    memoryBefore: memoryMb(),
    started: performance.now()
  };
  try {
    if (config.kind === "sealed") return await runSealedAuctionLoad(config, runtime);
    if (config.kind === "dutch") return await runDutchStopConflicts(config, runtime);
    return await runColdRecoveryBurst(config, runtime);
  } catch (error) {
    return summarizeFailure(config.label, config.rooms, config.rooms * 4, runtime.metrics, runtime.started, runtime.memoryBefore, error);
  }
}

async function runSealedAuctionLoad(config: StressScenarioConfig, runtime: ScenarioRuntime): Promise<StressScenarioSummary> {
  const { metrics, memoryBefore, started } = runtime;
  const bundle = await startApp(new InMemoryRoomRepository());
  const allSeats: ClientSeat[][] = [];
  try {
    await runPool(Array.from({ length: config.rooms }, (_, index) => index), config.concurrency, async (roomIndex) => {
      const seats = await createStartedRoom(bundle.url, roomIndex, metrics, config.label);
      allSeats[roomIndex] = seats;
      await advanceIntoAuction(seats, metrics, config.label);
      await resolveCurrentAuction(seats, metrics, config.label, 90);
      await waitFor(() => seats.some((seat) => seat.view.phase === "settlement"), stateTimeoutMs);
      assertNoHiddenLeak(seats, config.label);
      assertRoomInvariants(bundle.store.rooms.get(seats[0]!.view.roomId)!);
    });
  } finally {
    disconnectSeats(allSeats.flat());
    await bundle.io.close();
    await bundle.app.close();
  }
  return summarizeScenario(config.label, config.rooms, config.rooms * 4, metrics, started, memoryBefore);
}

async function runDutchStopConflicts(config: StressScenarioConfig, runtime: ScenarioRuntime): Promise<StressScenarioSummary> {
  const { metrics, memoryBefore, started } = runtime;
  const bundle = await startApp(new InMemoryRoomRepository());
  const allSeats: ClientSeat[][] = [];
  try {
    await runPool(Array.from({ length: config.rooms }, (_, index) => index), config.concurrency, async (roomIndex) => {
      const seats = await createStartedAuctionRoomWithMode(bundle.url, roomIndex, metrics, config.label, "dutch");
      allSeats[roomIndex] = seats;
      const results = await Promise.all([
        emitMeasured(metrics, config.label, seats[1]!, "dutch:stop", {}, { allowRuleError: true }),
        emitMeasured(metrics, config.label, seats[2]!, "dutch:stop", {}, { allowRuleError: true }),
        emitMeasured(metrics, config.label, seats[3]!, "dutch:stop", {}, { allowRuleError: true })
      ]);
      const successCount = results.filter((result) => result.ok).length;
      if (successCount !== 1) throw new Error(`Expected exactly one dutch stop success, got ${successCount}.`);
      await waitFor(() => seats.some((seat) => seat.view.phase === "settlement"), stateTimeoutMs);
      assertRoomInvariants(bundle.store.rooms.get(seats[0]!.view.roomId)!);
    });
  } finally {
    disconnectSeats(allSeats.flat());
    await bundle.io.close();
    await bundle.app.close();
  }
  return summarizeScenario(config.label, config.rooms, config.rooms * 4, metrics, started, memoryBefore);
}

async function runColdRecoveryBurst(config: StressScenarioConfig, runtime: ScenarioRuntime): Promise<StressScenarioSummary> {
  const { metrics, memoryBefore, started } = runtime;
  const tempDir = mkdtempSync(join(tmpdir(), "auctioneer-stress-"));
  const firstBundle = await startApp(new JsonFileRoomRepository(tempDir));
  const recoverableSeats: Array<Pick<ClientSeat, "token" | "seatIndex"> & { roomId: string; playerId: string; expectedOwnSealedBid?: number }> = [];
  const allSeats: ClientSeat[][] = [];
  try {
    await runPool(Array.from({ length: config.rooms }, (_, index) => index), config.concurrency, async (roomIndex) => {
      const seats = await createStartedAuctionRoomWithMode(firstBundle.url, roomIndex, metrics, config.label, "sealed");
      allSeats[roomIndex] = seats;
      await emitMeasured(metrics, config.label, seats[1]!, "sealedBid:submit", { amount: 70 });
      for (const seat of seats) {
        recoverableSeats.push({
          roomId: seat.view.roomId,
          playerId: seat.view.selfId,
          token: seat.token,
          seatIndex: seat.seatIndex,
          expectedOwnSealedBid: seat.seatIndex === 1 ? 70 : undefined
        });
      }
    });
    disconnectSeats(allSeats.flat());
    await firstBundle.io.close();
    await firstBundle.app.close();

    const secondBundle = await startApp(new JsonFileRoomRepository(tempDir));
    const resumedSeats: ClientSeat[] = [];
    try {
      await runPool(recoverableSeats, Math.min(80, recoverableSeats.length), async (record) => {
        const resumed = await resumeRoom(secondBundle.url, record, metrics, config.label);
        resumedSeats.push(resumed);
        if (resumed.view.phase !== "auction") throw new Error(`Recovered room expected auction phase, got ${resumed.view.phase}.`);
        if (record.expectedOwnSealedBid !== undefined && resumed.view.auction?.ownSealedBid !== record.expectedOwnSealedBid) {
          throw new Error("Recovered own sealed bid was lost.");
        }
        assertNoHiddenLeak([resumed], config.label);
      });
    } finally {
      disconnectSeats(resumedSeats);
      await secondBundle.io.close();
      await secondBundle.app.close();
    }
  } finally {
    try {
      await firstBundle.io.close();
      await firstBundle.app.close();
    } catch {
      // The first bundle is intentionally closed before cold recovery starts.
    }
    disconnectSeats(allSeats.flat());
    rmSync(tempDir, { recursive: true, force: true });
  }
  return summarizeScenario(config.label, config.rooms, config.rooms * 4, metrics, started, memoryBefore);
}

async function createStartedRoom(url: string, roomIndex: number, metrics: MetricRecord[], scenario: string): Promise<ClientSeat[]> {
  const p1 = await createRoom(url, `R${roomIndex}-A`, metrics, scenario, 0);
  const p2 = await joinRoom(url, p1.view.joinCode, `R${roomIndex}-B`, metrics, scenario, 1);
  const p3 = await joinRoom(url, p1.view.joinCode, `R${roomIndex}-C`, metrics, scenario, 2);
  const p4 = await joinRoom(url, p1.view.joinCode, `R${roomIndex}-D`, metrics, scenario, 3);
  const seats = [p1, p2, p3, p4];
  seats.forEach(bindUpdates);
  await Promise.all(seats.map((seat) => emitMeasured(metrics, scenario, seat, "player:ready", { ready: true })));
  await emitMeasured(metrics, scenario, p1, "room:start", {});
  await waitFor(() => seats.some((seat) => seat.view.phase === "dayIncome"), stateTimeoutMs);
  return seats;
}

async function createStartedAuctionRoomWithMode(
  url: string,
  roomIndex: number,
  metrics: MetricRecord[],
  scenario: string,
  wantedMode: BidMode
): Promise<ClientSeat[]> {
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const seats = await createStartedRoom(url, roomIndex * 100 + attempt, metrics, scenario);
    await advanceIntoAuction(seats, metrics, scenario);
    if (bidMode(seats[0]!.view) === wantedMode) return seats;
    disconnectSeats(seats);
  }
  throw new Error(`${scenario}: unable to create random ${wantedMode} auction room.`);
}

async function advanceIntoAuction(seats: ClientSeat[], metrics: MetricRecord[], scenario: string): Promise<void> {
  await emitMeasured(metrics, scenario, seats[0]!, "phase:advance", {});
  await emitMeasured(metrics, scenario, seats[0]!, "phase:advance", {});
  await emitMeasured(metrics, scenario, seats[1]!, "phase:advance", {});
  await waitFor(() => seats.some((seat) => seat.view.phase === "auction"), stateTimeoutMs);
}

async function resolveCurrentAuction(seats: ClientSeat[], metrics: MetricRecord[], scenario: string, amount: number): Promise<void> {
  const view = seats.find((seat) => seat.view.phase === "auction")?.view ?? seats[0]!.view;
  const mode = bidMode(view);
  const bidders = seats.filter((seat) => seat.view.selfId !== view.currentHostId);
  if (mode === "english") {
    await emitMeasured(metrics, scenario, bidders[0]!, "bid:place", { amount });
    for (const bidder of bidders.slice(1)) {
      if (bidder.view.phase === "auction") await emitMeasured(metrics, scenario, bidder, "bid:pass", {});
    }
    return;
  }
  if (mode === "dutch") {
    await emitMeasured(metrics, scenario, bidders[0]!, "dutch:stop", {});
    return;
  }
  for (const [index, bidder] of bidders.entries()) {
    if (bidder.view.phase === "auction") {
      await emitMeasured(metrics, scenario, bidder, "sealedBid:submit", { amount: Math.max(0, amount - index * 10) });
    }
  }
}

function bidMode(view: PlayerView): BidMode | undefined {
  if (!view.auction) return undefined;
  return view.auction.mode === "bundle" ? view.auction.bundleInnerMode ?? "english" : view.auction.mode;
}

async function startApp(repository: RoomRepository): Promise<AppBundle & { url: string }> {
  const bundle = await createApp(repository);
  await bundle.app.listen({ port: 0, host: "127.0.0.1" });
  const address = bundle.app.server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve test server address.");
  return { ...bundle, url: `http://127.0.0.1:${address.port}` };
}

async function createRoom(url: string, nickname: string, metrics: MetricRecord[], scenario: string, seatIndex: number): Promise<ClientSeat> {
  const socket = createClient(url, { transports: ["websocket"], reconnection: false }) as ClientSocket;
  const connectStarted = performance.now();
  await waitForConnect(socket);
  metrics.push({ scenario, event: "socket:connect", ms: performance.now() - connectStarted, ok: true });
  const response = await emitRawMeasured<{ view: PlayerView; sessionToken: string }>(metrics, scenario, socket, "room:create", { nickname });
  if (!response.ok) throw new Error(`room:create failed: ${response.error}`);
  return { socket, view: response.view, token: response.sessionToken, seatIndex };
}

async function joinRoom(url: string, joinCode: string, nickname: string, metrics: MetricRecord[], scenario: string, seatIndex: number): Promise<ClientSeat> {
  const socket = createClient(url, { transports: ["websocket"], reconnection: false }) as ClientSocket;
  const connectStarted = performance.now();
  await waitForConnect(socket);
  metrics.push({ scenario, event: "socket:connect", ms: performance.now() - connectStarted, ok: true });
  const response = await emitRawMeasured<{ view: PlayerView; sessionToken: string }>(metrics, scenario, socket, "room:join", { joinCode, nickname });
  if (!response.ok) throw new Error(`room:join failed: ${response.error}`);
  return { socket, view: response.view, token: response.sessionToken, seatIndex };
}

async function resumeRoom(
  url: string,
  record: Pick<ClientSeat, "token" | "seatIndex"> & { roomId: string; playerId: string },
  metrics: MetricRecord[],
  scenario: string
): Promise<ClientSeat> {
  const socket = createClient(url, { transports: ["websocket"], reconnection: false }) as ClientSocket;
  const connectStarted = performance.now();
  await waitForConnect(socket);
  metrics.push({ scenario, event: "socket:connect:resume", ms: performance.now() - connectStarted, ok: true });
  const response = await emitRawMeasured<{ view: PlayerView }>(metrics, scenario, socket, "room:resume", {
    roomId: record.roomId,
    playerId: record.playerId,
    sessionToken: record.token
  });
  if (!response.ok) throw new Error(`room:resume failed: ${response.error}`);
  const seat = { socket, view: response.view, token: record.token, seatIndex: record.seatIndex };
  bindUpdates(seat);
  return seat;
}

function bindUpdates(seat: ClientSeat): void {
  seat.socket.on("room:update", (view) => {
    seat.view = view;
  });
}

async function emitMeasured<T>(
  metrics: MetricRecord[],
  scenario: string,
  seat: ClientSeat,
  event: keyof ClientToServerEvents,
  payload: unknown,
  options: { allowRuleError?: boolean } = {}
): Promise<AckResponse<T & { view?: PlayerView }>> {
  const response = await emitRawMeasured<T & { view?: PlayerView }>(metrics, scenario, seat.socket, event, payload, options);
  if (response.ok && response.view) seat.view = response.view;
  return response;
}

async function emitRawMeasured<T>(
  metrics: MetricRecord[],
  scenario: string,
  socket: ClientSocket,
  event: keyof ClientToServerEvents,
  payload: unknown,
  options: { allowRuleError?: boolean } = {}
): Promise<AckResponse<T>> {
  const started = performance.now();
  return new Promise<AckResponse<T>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = `${String(event)} ack timeout`;
      metrics.push({ scenario, event: String(event), ms: performance.now() - started, ok: false, error });
      reject(new Error(error));
    }, ackTimeoutMs);
    (socket.emit as unknown as (event: string, payload: unknown, ack: (response: AckResponse<T>) => void) => void)(String(event), payload, (response) => {
      clearTimeout(timeout);
      const ms = performance.now() - started;
      if (!response.ok) {
        metrics.push({
          scenario,
          event: String(event),
          ms,
          ok: false,
          expectedRuleError: options.allowRuleError,
          error: response.error
        });
        if (options.allowRuleError) resolve(response);
        else reject(new Error(`${String(event)} failed: ${response.error}`));
        return;
      }
      metrics.push({ scenario, event: String(event), ms, ok: true });
      resolve(response);
    });
  });
}

async function waitForConnect(socket: ClientSocket): Promise<void> {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket connection timeout.")), connectTimeoutMs);
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) throw new Error("Timed out waiting for state propagation.");
    await wait(20);
  }
}

async function runPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

function assertNoHiddenLeak(seats: ClientSeat[], scenario: string): void {
  for (const seat of seats) {
    for (const artifact of seat.view.todayArtifacts) {
      if (seat.view.phase === "finalScoring" || artifact.ownerId === seat.view.selfId) continue;
      if (artifact.trueValue !== undefined || artifact.properties !== undefined || artifact.tag !== undefined) {
        throw new Error(`${scenario}: hidden artifact leak for ${seat.view.self.nickname}.`);
      }
    }
    if (seat.view.self.role?.id !== "role05" && seat.view.auction?.visibleSealedBids) {
      throw new Error(`${scenario}: non-gambler saw sealed bids.`);
    }
  }
}

function assertRoomInvariants(room: GameState): void {
  const seenArtifacts = new Set<string>();
  for (const player of room.players) {
    if (!Number.isFinite(player.cash)) throw new Error(`Invalid cash for ${player.id}.`);
    for (const artifactId of player.artifacts) {
      if (seenArtifacts.has(artifactId)) throw new Error(`Duplicate artifact ownership for ${artifactId}.`);
      seenArtifacts.add(artifactId);
      if (room.artifacts[artifactId]?.ownerId !== player.id) throw new Error(`Owner mismatch for ${artifactId}.`);
    }
  }
}

function summarizeScenario(
  scenario: string,
  rooms: number,
  sockets: number,
  metrics: MetricRecord[],
  started: number,
  memoryBeforeMb: number
): StressScenarioSummary {
  const unexpectedErrors = metrics.filter((metric) => !metric.ok && !metric.expectedRuleError).length;
  const expectedRuleErrors = metrics.filter((metric) => !metric.ok && metric.expectedRuleError).length;
  if (unexpectedErrors > 0) {
    const first = metrics.find((metric) => !metric.ok && !metric.expectedRuleError);
    throw new Error(`${scenario} had unexpected error: ${first?.event} ${first?.error}`);
  }
  return {
    scenario,
    rooms,
    sockets,
    actions: metrics.length,
    okActions: metrics.filter((metric) => metric.ok).length,
    expectedRuleErrors,
    unexpectedErrors,
    totalMs: round(performance.now() - started),
    ack: latencyStats(metrics.filter((metric) => metric.ok).map((metric) => metric.ms)),
    byEvent: summarizeByEvent(metrics),
    memoryBeforeMb,
    memoryAfterMb: memoryMb()
  };
}

function summarizeFailure(
  scenario: string,
  rooms: number,
  sockets: number,
  metrics: MetricRecord[],
  started: number,
  memoryBeforeMb: number,
  error: unknown
): StressScenarioFailure {
  const unexpectedErrors = metrics.filter((metric) => !metric.ok && !metric.expectedRuleError).length;
  const expectedRuleErrors = metrics.filter((metric) => !metric.ok && metric.expectedRuleError).length;
  return {
    scenario,
    rooms,
    sockets,
    actions: metrics.length,
    okActions: metrics.filter((metric) => metric.ok).length,
    expectedRuleErrors,
    unexpectedErrors,
    totalMs: round(performance.now() - started),
    ack: latencyStats(metrics.filter((metric) => metric.ok).map((metric) => metric.ms)),
    byEvent: summarizeByEvent(metrics),
    memoryBeforeMb,
    memoryAfterMb: memoryMb(),
    error: error instanceof Error ? error.message : String(error)
  };
}

function readScale(): StressScale {
  const scale = (process.env.STRESS_SCALE ?? "standard").toLowerCase();
  if (scale === "quick") {
    return {
      name: "quick",
      scenarios: [
        { kind: "sealed", rooms: 5, concurrency: 3, label: "quick-5rooms-20players" },
        { kind: "dutch", rooms: 3, concurrency: 2, label: "quick-conflict-3rooms-dutch-stop" },
        { kind: "recovery", rooms: 3, concurrency: 2, label: "quick-recovery-3rooms-12players" }
      ]
    };
  }
  if (scale === "soak") {
    return {
      name: "soak",
      scenarios: [
        { kind: "sealed", rooms: 50, concurrency: 20, label: "soak-baseline-50rooms-200players" },
        { kind: "sealed", rooms: 100, concurrency: 30, label: "soak-large-100rooms-400players" },
        { kind: "sealed", rooms: 150, concurrency: 35, label: "soak-xl-150rooms-600players" },
        { kind: "dutch", rooms: 50, concurrency: 15, label: "soak-conflict-50rooms-dutch-stop" },
        { kind: "recovery", rooms: 60, concurrency: 20, label: "soak-recovery-60rooms-240players" }
      ]
    };
  }
  if (scale === "recovery") {
    return {
      name: "recovery",
      scenarios: [{ kind: "recovery", rooms: 30, concurrency: 15, label: "recovery-30rooms-120players" }]
    };
  }
  return {
    name: "standard",
    scenarios: [
      { kind: "sealed", rooms: 20, concurrency: 10, label: "baseline-20rooms-80players" },
      { kind: "sealed", rooms: 50, concurrency: 20, label: "load-50rooms-200players" },
      { kind: "sealed", rooms: 100, concurrency: 35, label: "large-100rooms-400players" },
      { kind: "dutch", rooms: 25, concurrency: 10, label: "conflict-25rooms-dutch-stop" },
      { kind: "recovery", rooms: 30, concurrency: 15, label: "recovery-30rooms-120players" }
    ]
  };
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function summarizeByEvent(metrics: MetricRecord[]): Record<string, LatencyStats & { count: number; errors: number }> {
  const grouped = new Map<string, MetricRecord[]>();
  for (const metric of metrics) {
    const current = grouped.get(metric.event) ?? [];
    current.push(metric);
    grouped.set(metric.event, current);
  }
  return Object.fromEntries(
    [...grouped.entries()].map(([event, records]) => [
      event,
      {
        count: records.length,
        errors: records.filter((record) => !record.ok).length,
        ...latencyStats(records.filter((record) => record.ok).map((record) => record.ms))
      }
    ])
  );
}

function latencyStats(values: number[]): LatencyStats {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted.at(-1)!)
  };
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index]!;
}

function disconnectSeats(seats: ClientSeat[]): void {
  for (const seat of seats) {
    if (seat.socket.connected) seat.socket.disconnect();
  }
}

function memoryMb(): number {
  return round(process.memoryUsage().rss / 1024 / 1024);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
