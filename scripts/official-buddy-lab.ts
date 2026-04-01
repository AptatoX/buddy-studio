import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execSync, spawn } from 'child_process'

type ClaudeConfig = {
  userID?: string
  companion?: {
    name?: string
    personality?: string
    hatchedAt?: number
  }
  companionMuted?: boolean
  [key: string]: unknown
}

const home =
  process.env.USERPROFILE ??
  process.env.HOME ??
  ((process.env.HOMEDRIVE ?? '') + (process.env.HOMEPATH ?? ''))

if (!home) {
  throw new Error('Could not resolve home directory from environment')
}

const configPath = join(home, '.claude.json')
const backupDir = join(import.meta.dir, '..', '.buddy-lab')
const backupPath = join(backupDir, 'claude.json.bak')
const htmlPath = join(import.meta.dir, '..', 'tools', 'official-buddy-lab', 'index.html')

function ensureBackup() {
  if (!existsSync(configPath)) {
    throw new Error(`Claude config not found: ${configPath}`)
  }
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true })
  }
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, readFileSync(configPath))
  }
}

function readConfig(): ClaudeConfig {
  ensureBackup()
  return JSON.parse(readFileSync(configPath, 'utf8')) as ClaudeConfig
}

function writeConfig(config: ClaudeConfig) {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function getState() {
  const config = readConfig()
  return {
    configPath,
    backupPath,
    userID: config.userID ?? null,
    companion: config.companion ?? null,
    companionMuted: config.companionMuted ?? false,
  }
}

function clearCompanionWithUserId(userID: string) {
  const config = readConfig()
  const updated: ClaudeConfig = {
    ...config,
    userID,
    companionMuted: false,
  }
  delete updated.companion
  writeConfig(updated)
  return getState()
}

function prepareFreshHatch() {
  const config = readConfig()
  const updated: ClaudeConfig = {
    ...config,
    userID: '',
    companionMuted: false,
  }
  writeConfig(updated)
  return getState()
}

function openClaude() {
  const child = spawn('claude', {
    detached: true,
    stdio: 'ignore',
    shell: true,
  })
  child.unref()
}

function focusClaudeWindow() {
  if (process.platform !== 'win32') {
    return
  }

  const script = `
try {
  $wshell = New-Object -ComObject WScript.Shell
  $null = $wshell.AppActivate("Claude Code")
  Start-Sleep -Milliseconds 150
} catch {}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinApi {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$procs = Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
foreach ($proc in $procs) {
  [WinApi]::ShowWindowAsync($proc.MainWindowHandle, 9) | Out-Null
  Start-Sleep -Milliseconds 120
  [WinApi]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 120
}
`

  try {
    execSync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  } catch {
    // Focus is best-effort only.
  }
}

function isClaudeRunning(): boolean {
  if (process.platform === 'win32') {
    try {
      const output = execSync(
        `powershell -NoProfile -Command "Get-Process -Name claude -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"`,
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim()
      return output.length > 0
    } catch {
      return false
    }
  }

  try {
    execSync('pgrep -x claude', {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

function restoreBackup() {
  ensureBackup()
  writeFileSync(configPath, readFileSync(backupPath))
  return getState()
}

const html = readFileSync(htmlPath, 'utf8')

function createHandler() {
  return async function fetch(req: Request) {
    const url = new URL(req.url)

    if (url.pathname === '/') {
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    if (url.pathname === '/api/state') {
      return Response.json(getState())
    }

    if (url.pathname === '/api/set-userid' && req.method === 'POST') {
      try {
        const body = (await req.json()) as { userID?: string }
        const userID = body.userID?.trim()
        if (!userID) {
          return Response.json({ error: 'Missing userID' }, { status: 400 })
        }
        return Response.json(clearCompanionWithUserId(userID))
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        )
      }
    }

    if (url.pathname === '/api/hatch' && req.method === 'POST') {
      try {
        const state = prepareFreshHatch()
        const alreadyRunning = isClaudeRunning()
        if (!alreadyRunning) {
          openClaude()
        }
        focusClaudeWindow()
        return Response.json({
          ...state,
          claudeAlreadyRunning: alreadyRunning,
          launchedClaude: !alreadyRunning,
        })
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        )
      }
    }

    if (url.pathname === '/api/restore' && req.method === 'POST') {
      try {
        return Response.json(restoreBackup())
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        )
      }
    }

    return new Response('Not Found', { status: 404 })
  }
}

const handler = createHandler()

function killPreviousLabOnPort(port: number) {
  if (process.platform !== 'win32') {
    return
  }

  try {
    const output = execSync(
      `cmd /c "netstat -ano | findstr :${port}"`,
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )

    const pids = Array.from(
      new Set(
        output
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean)
          .map(line => {
            const parts = line.split(/\s+/)
            return Number(parts[parts.length - 1])
          })
          .filter(value => Number.isFinite(value) && value > 0 && value !== process.pid),
      ),
    )

    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, {
          stdio: ['ignore', 'ignore', 'ignore'],
        })
      } catch {
        // Ignore race conditions where the old process already exited.
      }
    }
  } catch {
    // If probing fails, let Bun.serve surface the actual bind error.
  }
}

const selectedPort = 4317
killPreviousLabOnPort(selectedPort)

Bun.serve({
  port: selectedPort,
  fetch: handler,
})

console.log(`Official Buddy Lab: http://127.0.0.1:${selectedPort}`)
