import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import http from "http";
import { join } from "path";
import { execSync } from "child_process";

const home =
  process.env.USERPROFILE ??
  process.env.HOME ??
  ((process.env.HOMEDRIVE ?? "") + (process.env.HOMEPATH ?? ""));

if (!home) {
  throw new Error("Could not resolve home directory from environment");
}

const configPath = join(home, ".claude.json");
const backupDir = join(import.meta.dirname, "..", ".buddy-lab");
const backupPath = join(backupDir, "claude.json.bak");
const htmlPath = join(import.meta.dirname, "..", "tools", "official-buddy-lab", "index.html");
const selectedPort = 4317;

function commandOutput(command) {
  return execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function ensureBackup() {
  if (!existsSync(configPath)) {
    throw new Error(`Claude config not found: ${configPath}`);
  }
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, readFileSync(configPath));
  }
}

function readConfig() {
  ensureBackup();
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function writeConfig(config) {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function getState() {
  const config = readConfig();
  return {
    configPath,
    backupPath,
    userID: config.userID ?? null,
    companion: config.companion ?? null,
    companionMuted: config.companionMuted ?? false,
  };
}

function clearCompanionWithUserId(userID) {
  const config = readConfig();
  const updated = {
    ...config,
    userID,
    companionMuted: false,
  };
  delete updated.companion;
  writeConfig(updated);
  return getState();
}

function prepareFreshHatch() {
  const config = readConfig();
  const updated = {
    ...config,
    userID: "",
    companionMuted: false,
  };
  delete updated.companion;
  writeConfig(updated);
  return getState();
}

function restoreBackup() {
  ensureBackup();
  writeFileSync(configPath, readFileSync(backupPath));
  return getState();
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function killPreviousLabOnPort(port) {
  try {
    const pids = process.platform === "win32"
      ? Array.from(
          new Set(
            commandOutput(`cmd /c "netstat -ano | findstr :${port}"`)
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => {
                const parts = line.split(/\s+/);
                return Number(parts[parts.length - 1]);
              })
              .filter((value) => Number.isFinite(value) && value > 0 && value !== process.pid),
          ),
        )
      : process.platform === "darwin"
        ? Array.from(
            new Set(
              commandOutput(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`)
                .split(/\r?\n/)
                .map((line) => Number(line.trim()))
                .filter((value) => Number.isFinite(value) && value > 0 && value !== process.pid),
            ),
          )
        : [];

    for (const pid of pids) {
      try {
        process.kill(pid, process.platform === "win32" ? "SIGKILL" : "SIGTERM");
      } catch {
        // Ignore race conditions where the old process already exited.
      }
    }
  } catch {
    // If probing fails, let server.listen surface the actual bind error.
  }
}

const html = readFileSync(htmlPath, "utf8");

killPreviousLabOnPort(selectedPort);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${selectedPort}`}`);

    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      sendJson(res, 200, getState());
      return;
    }

    if (url.pathname === "/api/set-userid" && req.method === "POST") {
      const body = await readJsonBody(req);
      const userID = typeof body.userID === "string" ? body.userID.trim() : "";
      if (!userID) {
        sendJson(res, 400, { error: "Missing userID" });
        return;
      }
      sendJson(res, 200, clearCompanionWithUserId(userID));
      return;
    }

    if (url.pathname === "/api/hatch" && req.method === "POST") {
      const state = prepareFreshHatch();
      sendJson(res, 200, {
        ...state,
        claudeAlreadyRunning: false,
        launchedClaude: false,
      });
      return;
    }

    if (url.pathname === "/api/restore" && req.method === "POST") {
      sendJson(res, 200, restoreBackup());
      return;
    }

    sendJson(res, 404, { error: "Not Found" });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(selectedPort, "127.0.0.1", () => {
  console.log(`Official Buddy Lab: http://127.0.0.1:${selectedPort}`);
});
