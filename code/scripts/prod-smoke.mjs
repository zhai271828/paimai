import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const port = Number(process.env.PROD_SMOKE_PORT ?? 4173);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = resolve(root, "output/prod-smoke-data");
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOST: "127.0.0.1",
    AUCTIONEER_ALLOWED_ORIGINS: `${baseUrl},http://localhost:${port}`,
    AUCTIONEER_DATA_DIR: dataDir,
    AUCTIONEER_SQLITE_PATH: resolve(dataDir, "auctioneer.sqlite"),
    AUCTIONEER_STATIC_DIR: resolve(root, "apps/web/dist")
  }
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  await waitForHealth(`${baseUrl}/health`, 15_000);
  await run("node", ["scripts/e2e-browser.mjs"], {
    ...process.env,
    E2E_BASE_URL: baseUrl
  });
  console.log(`prod-smoke ok ${baseUrl}`);
} finally {
  child.kill();
  await new Promise((resolveExit) => child.once("exit", resolveExit));
  if (process.env.PROD_SMOKE_LOGS === "1") {
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
  }
}

async function waitForHealth(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveRetry) => setTimeout(resolveRetry, 250));
  }
  throw new Error(`Production server did not become healthy: ${lastError?.message ?? "unknown error"}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function run(command, args, env) {
  await new Promise((resolveRun, rejectRun) => {
    const runner = spawn(command, args, { cwd: root, stdio: "inherit", env });
    runner.on("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
    runner.on("error", rejectRun);
  });
}
