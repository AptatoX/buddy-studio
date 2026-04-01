const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const pty = require("node-pty");
const WebSocket = require("ws");
const { execSync } = require("child_process");

const PORT = 4322;
const HOST = "127.0.0.1";
const INDEX_PATH = path.join(__dirname, "web-terminal.html");

function commandOutput(command) {
  return execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function resolveClaudePath() {
  const candidates = process.platform === "win32"
    ? [
        path.join(os.homedir(), "AppData", "Roaming", "npm", "claude.cmd"),
        path.join(os.homedir(), "AppData", "Roaming", "npm", "claude"),
        "claude.cmd",
        "claude",
      ]
    : [
        path.join(os.homedir(), ".local", "bin", "claude"),
        path.join(os.homedir(), ".npm-global", "bin", "claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "claude",
      ];

  for (const candidate of candidates) {
    try {
      if (candidate === "claude" || candidate === "claude.cmd") {
        const lookup = process.platform === "win32"
          ? `where.exe ${candidate}`
          : `command -v ${candidate}`;
        const output = commandOutput(lookup);
        const resolved = output.split(/\r?\n/).find(Boolean);
        if (resolved) {
          return resolved;
        }
        continue;
      }

      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
    }
  }

  throw new Error("Could not locate Claude Code executable");
}

const CLAUDE_CMD = resolveClaudePath();

function killPreviousServerOnPort(port) {
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
      }
    }
  } catch {
  }
}

killPreviousServerOnPort(PORT);

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(INDEX_PATH, "utf8"));
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

const wss = new WebSocket.Server({ server, path: "/pty" });

wss.on("connection", (ws) => {
  let shell;

  try {
    shell = pty.spawn(CLAUDE_CMD, [], {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: process.cwd(),
      env: process.env,
    });
  } catch (error) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "data",
          data: `\r\n[Failed to start Claude: ${error instanceof Error ? error.message : String(error)}]\r\n`,
        }),
      );
      ws.close();
    }
    return;
  }

  const onData = (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "data", data }));
    }
  };

  shell.onData(onData);

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === "input") {
        shell.write(message.data);
      } else if (message.type === "resize") {
        const cols = Number(message.cols) || 120;
        const rows = Number(message.rows) || 32;
        shell.resize(cols, rows);
      }
    } catch {
    }
  });

  ws.on("close", () => {
    try {
      shell.kill();
    } catch {
    }
  });

  shell.onExit(({ exitCode, signal }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "exit",
          exitCode,
          signal,
        }),
      );
      ws.close();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Web TTY: http://${HOST}:${PORT}`);
});
