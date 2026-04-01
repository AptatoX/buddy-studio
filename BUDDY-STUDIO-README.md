# Buddy Studio

Legacy notes for Buddy Studio. See `README.md` for the current setup and GitHub-facing documentation.

## Requirements

- Windows or macOS
- Claude Code installed locally
- Node.js in `PATH`

## Start

Option 1:

```bat
run-buddy-studio.bat
```

Option 2 on macOS:

```bash
chmod +x run-buddy-studio.command
./run-buddy-studio.command
```

Then open:

```text
http://127.0.0.1:4317
```

## How It Works

1. Click `Hatch`
2. The tool clears `userID` in `~/.claude.json`
3. It sends `/buddy` into the web Claude terminal
4. The page waits for Claude Code to write a new `userID`
5. Once detected, the new buddy and `userID` are shown on the right

## Files

- `tools/official-buddy-lab/index.html`: main buddy studio page
- `tools/claude-web-tty/server.js`: web terminal backend
- `tools/claude-web-tty/web-terminal.html`: embedded Claude terminal
- `scripts/official-buddy-lab.mjs`: config/state API
- `run-buddy-studio.bat`: easy Windows launcher
- `run-buddy-studio.command`: easy macOS launcher
