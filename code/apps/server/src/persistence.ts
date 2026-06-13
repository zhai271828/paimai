import type { ActionLog, GameState, RoomId, RoomSnapshot } from "@auctioneer/shared";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface PersistedSession {
  token: string;
  roomId: RoomId;
  playerId: string;
}

export interface RoomRepository {
  appendAction(action: ActionLog): void;
  saveSnapshot(snapshot: RoomSnapshot): void;
  loadLatestSnapshot(roomId: RoomId): RoomSnapshot | undefined;
  loadLatestSnapshots?(): RoomSnapshot[];
  listActionsAfter(roomId: RoomId, actionIndex: number): ActionLog[];
  saveSession(session: PersistedSession): void;
  loadSession(token: string): PersistedSession | undefined;
}

export class InMemoryRoomRepository implements RoomRepository {
  private readonly actions: ActionLog[] = [];
  private readonly snapshots = new Map<RoomId, RoomSnapshot[]>();
  private readonly sessions = new Map<string, PersistedSession>();

  appendAction(action: ActionLog): void {
    this.actions.push(structuredClone(action));
  }

  saveSnapshot(snapshot: RoomSnapshot): void {
    const roomSnapshots = this.snapshots.get(snapshot.roomId) ?? [];
    roomSnapshots.push(structuredClone(snapshot));
    this.snapshots.set(snapshot.roomId, roomSnapshots);
  }

  loadLatestSnapshot(roomId: RoomId): RoomSnapshot | undefined {
    const snapshots = this.snapshots.get(roomId) ?? [];
    const latest = snapshots.at(-1);
    return latest ? structuredClone(latest) : undefined;
  }

  loadLatestSnapshots(): RoomSnapshot[] {
    return [...this.snapshots.values()].map((snapshots) => snapshots.at(-1)).filter(Boolean).map((snapshot) => structuredClone(snapshot!));
  }

  listActionsAfter(roomId: RoomId, actionIndex: number): ActionLog[] {
    return this.actions.filter((action) => action.roomId === roomId && action.actionIndex > actionIndex).map((action) => structuredClone(action));
  }

  saveSession(session: PersistedSession): void {
    this.sessions.set(session.token, structuredClone(session));
  }

  loadSession(token: string): PersistedSession | undefined {
    const session = this.sessions.get(token);
    return session ? structuredClone(session) : undefined;
  }
}

export class JsonFileRoomRepository implements RoomRepository {
  private readonly actionsFile: string;
  private readonly snapshotsFile: string;
  private readonly sessionsFile: string;
  private actionsCache?: ActionLog[];
  private snapshotsCache?: Map<RoomId, RoomSnapshot>;
  private sessionsCache?: Map<string, PersistedSession>;

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.actionsFile = join(directory, "actions.jsonl");
    this.snapshotsFile = join(directory, "snapshots.jsonl");
    this.sessionsFile = join(directory, "sessions.jsonl");
  }

  appendAction(action: ActionLog): void {
    appendJsonLine(this.actionsFile, action);
    this.actionsCache?.push(structuredClone(action));
  }

  saveSnapshot(snapshot: RoomSnapshot): void {
    appendJsonLine(this.snapshotsFile, snapshot);
    const snapshots = this.snapshotsCache;
    if (snapshots) {
      const current = snapshots.get(snapshot.roomId);
      if (!current || snapshot.actionIndex >= current.actionIndex) snapshots.set(snapshot.roomId, structuredClone(snapshot));
    }
  }

  loadLatestSnapshot(roomId: RoomId): RoomSnapshot | undefined {
    const snapshot = this.loadSnapshotCache().get(roomId);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  loadLatestSnapshots(): RoomSnapshot[] {
    return [...this.loadSnapshotCache().values()].map((snapshot) => structuredClone(snapshot));
  }

  listActionsAfter(roomId: RoomId, actionIndex: number): ActionLog[] {
    return this.loadActionCache()
      .filter((action) => action.roomId === roomId && action.actionIndex > actionIndex)
      .map((action) => structuredClone(action));
  }

  saveSession(session: PersistedSession): void {
    appendJsonLine(this.sessionsFile, session);
    this.sessionsCache?.set(session.token, structuredClone(session));
  }

  loadSession(token: string): PersistedSession | undefined {
    const session = this.loadSessionCache().get(token);
    return session ? structuredClone(session) : undefined;
  }

  private loadActionCache(): ActionLog[] {
    if (!this.actionsCache) this.actionsCache = readJsonLines<ActionLog>(this.actionsFile);
    return this.actionsCache;
  }

  private loadSnapshotCache(): Map<RoomId, RoomSnapshot> {
    if (!this.snapshotsCache) {
      this.snapshotsCache = new Map();
      for (const snapshot of readJsonLines<RoomSnapshot>(this.snapshotsFile)) {
        const current = this.snapshotsCache.get(snapshot.roomId);
        if (!current || snapshot.actionIndex >= current.actionIndex) this.snapshotsCache.set(snapshot.roomId, snapshot);
      }
    }
    return this.snapshotsCache;
  }

  private loadSessionCache(): Map<string, PersistedSession> {
    if (!this.sessionsCache) {
      this.sessionsCache = new Map();
      for (const session of readJsonLines<PersistedSession>(this.sessionsFile)) this.sessionsCache.set(session.token, session);
    }
    return this.sessionsCache;
  }
}

export class SqliteRoomRepository implements RoomRepository {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    const directory = databasePath.includes("/") || databasePath.includes("\\") ? databasePath.replace(/[\\/][^\\/]+$/, "") : "";
    if (directory) mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS actions (
        room_id TEXT NOT NULL,
        action_index INTEGER NOT NULL,
        action_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, action_index)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        room_id TEXT PRIMARY KEY,
        action_index INTEGER NOT NULL,
        snapshot_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        content_version TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_actions_room_index ON actions (room_id, action_index);
      CREATE INDEX IF NOT EXISTS idx_sessions_room_player ON sessions (room_id, player_id);
    `);
  }

  appendAction(action: ActionLog): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO actions (room_id, action_index, action_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(action.roomId, action.actionIndex, action.actionId, JSON.stringify(action), action.createdAt);
  }

  saveSnapshot(snapshot: RoomSnapshot): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO snapshots (room_id, action_index, snapshot_id, payload, content_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(snapshot.roomId, snapshot.actionIndex, snapshot.id, JSON.stringify(snapshot), snapshot.contentVersion ?? null, snapshot.createdAt);
  }

  loadLatestSnapshot(roomId: RoomId): RoomSnapshot | undefined {
    const row = this.db.prepare("SELECT payload FROM snapshots WHERE room_id = ?").get(roomId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as RoomSnapshot) : undefined;
  }

  loadLatestSnapshots(): RoomSnapshot[] {
    const rows = this.db.prepare("SELECT payload FROM snapshots ORDER BY created_at ASC").all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as RoomSnapshot);
  }

  listActionsAfter(roomId: RoomId, actionIndex: number): ActionLog[] {
    const rows = this.db.prepare("SELECT payload FROM actions WHERE room_id = ? AND action_index > ? ORDER BY action_index ASC").all(roomId, actionIndex) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as ActionLog);
  }

  saveSession(session: PersistedSession): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (token, room_id, player_id, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(session.token, session.roomId, session.playerId, Date.now());
  }

  loadSession(token: string): PersistedSession | undefined {
    const row = this.db.prepare("SELECT token, room_id as roomId, player_id as playerId FROM sessions WHERE token = ?").get(token) as PersistedSession | undefined;
    return row ? structuredClone(row) : undefined;
  }

  close(): void {
    this.db.close();
  }
}

export function snapshotFromState(state: GameState): RoomSnapshot {
  return {
    id: `snapshot_${state.roomId}_${state.actionIndex}`,
    roomId: state.roomId,
    actionIndex: state.actionIndex,
    state: structuredClone(state),
    contentVersion: state.contentVersion,
    createdAt: Date.now()
  };
}

function appendJsonLine(file: string, value: unknown): void {
  appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
