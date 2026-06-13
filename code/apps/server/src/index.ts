import { createApp } from "./app.js";
import { InMemoryRoomRepository, JsonFileRoomRepository, SqliteRoomRepository } from "./persistence.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";
const dataDir = process.env.AUCTIONEER_DATA_DIR ?? "data/rooms";
const sqlitePath = process.env.AUCTIONEER_SQLITE_PATH ?? `${dataDir}/auctioneer.sqlite`;
const repositoryMode = process.env.AUCTIONEER_REPOSITORY ?? "sqlite";

const repository =
  repositoryMode === "memory"
    ? new InMemoryRoomRepository()
    : repositoryMode === "jsonl"
      ? new JsonFileRoomRepository(dataDir)
      : new SqliteRoomRepository(sqlitePath);
const { app } = await createApp(repository);

await app.listen({ port, host });
console.log(`Auctioneer server listening on http://${host}:${port}`);
console.log(`Auctioneer repository: ${repositoryMode === "memory" ? "memory" : repositoryMode === "jsonl" ? `jsonl:${dataDir}` : `sqlite:${sqlitePath}`}`);
