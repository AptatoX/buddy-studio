import http from 'http'
import { chmodSync, existsSync } from 'fs'
import os from 'os'
import { join } from 'path'
import { execSync, spawn, spawnSync } from 'child_process'

const workspace = process.cwd()
const webTtyPath = join(workspace, 'tools', 'claude-web-tty', 'server.js')
const labPath = join(workspace, 'scripts', 'official-buddy-lab.mjs')
const webTtyModulesPath = join(workspace, 'tools', 'claude-web-tty', 'node_modules')
const claudeConfigPath = join(os.homedir(), '.claude.json')
const WEB_TTY_PORT = 4322
const LAB_PORT = 4317
const STARTUP_TIMEOUT_MS = 15000
const NODE_CMD = process.execPath
const NPM_COMMAND = process.platform === 'win32'
  ? { command: 'cmd', args: ['/c', 'npm'] }
  : { command: 'npm', args: [] }

function commandOutput(command) {
  return execSync(command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getClaudeCandidates() {
  return process.platform === 'win32'
    ? [
        join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude'),
        'claude.cmd',
        'claude',
      ]
    : [
        join(os.homedir(), '.local', 'bin', 'claude'),
        join(os.homedir(), '.npm-global', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        'claude',
      ]
}

function resolveClaudePath() {
  const candidates = getClaudeCandidates()

  for (const candidate of candidates) {
    try {
      if (candidate === 'claude' || candidate === 'claude.cmd') {
        const lookup = process.platform === 'win32'
          ? `where.exe ${candidate}`
          : `command -v ${candidate}`
        const output = commandOutput(lookup)
        const resolved = output.split(/\r?\n/).find(Boolean)
        if (resolved) {
          return resolved
        }
        continue
      }

      if (existsSync(candidate)) {
        return candidate
      }
    } catch {
    }
  }

  const installHint = process.platform === 'win32'
    ? 'Install Claude Code and make sure `claude` is available in PATH.'
    : 'Install Claude Code and make sure `claude` is available on your shell PATH.'

  throw new Error(
    [
      'Could not locate the Claude Code executable.',
      installHint,
      'Checked:',
      ...candidates.map((candidate) => `  - ${candidate}`),
    ].join('\n'),
  )
}

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : ['open', [url]]

  const child = spawn(command[0], command[1], {
    cwd: workspace,
    detached: true,
    stdio: 'ignore',
    shell: false,
  })

  child.unref()
}

function runCommandSync(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    shell: false,
    ...options,
  })
}

function ensureCommand(command, args, label) {
  const probe = runCommandSync(command, [...args, '--version'])

  if (probe.error || probe.status !== 0) {
    const details = `${probe.stdout ?? ''}${probe.stderr ?? ''}${probe.error?.message ?? ''}`.trim()
    throw new Error(
      [
        `${label} was not found in PATH.`,
        details || '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

function runNpmCommand(args, options = {}) {
  return runCommandSync(NPM_COMMAND.command, [...NPM_COMMAND.args, ...args], options)
}

function installWebTtyDependencies(reason) {
  console.log(reason)
  console.log('Installing Web TTY dependencies with npm...')

  const result = runNpmCommand(['install'], {
    cwd: join(workspace, 'tools', 'claude-web-tty'),
    stdio: 'inherit',
  })

  if (result.error || result.status !== 0) {
    throw new Error('Failed to install Web TTY dependencies automatically. Run `npm install` in tools/claude-web-tty and try again.')
  }
}

function ensureMacSpawnHelpersExecutable() {
  if (process.platform !== 'darwin') {
    return
  }

  const helperPaths = [
    join(webTtyModulesPath, 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    join(webTtyModulesPath, 'node-pty', 'prebuilds', 'darwin-x64', 'spawn-helper'),
  ]

  for (const helperPath of helperPaths) {
    if (!existsSync(helperPath)) {
      continue
    }

    try {
      chmodSync(helperPath, 0o755)
    } catch (error) {
      throw new Error(
        [
          `Failed to grant execute permission to node-pty spawn helper: ${helperPath}`,
          error instanceof Error ? error.message : String(error),
        ].join('\n'),
      )
    }
  }
}

function ensureWebTtyDependencies() {
  ensureCommand(NPM_COMMAND.command, NPM_COMMAND.args, 'npm')

  if (!existsSync(webTtyModulesPath)) {
    installWebTtyDependencies(
      [
        'Web TTY dependencies are missing.',
        'Buddy Studio will try to install them automatically.',
      ].join('\n'),
    )
  }

  const verify = spawnSync(
    process.execPath,
    ['-e', 'require("node-pty")'],
    {
      cwd: join(workspace, 'tools', 'claude-web-tty'),
      encoding: 'utf8',
      shell: false,
    },
  )

  if (verify.status !== 0) {
    installWebTtyDependencies(
      [
        'The installed Web TTY dependencies do not match the current Node.js runtime.',
        'Buddy Studio will reinstall them automatically.',
        `${verify.stderr ?? verify.stdout ?? ''}`.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  ensureMacSpawnHelpersExecutable()
}

function startBackgroundProcess(command, args) {
  const child = spawn(command, args, {
    cwd: workspace,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  })

  let output = ''

  child.stdout?.on('data', (chunk) => {
    output += chunk.toString()
  })

  child.stderr?.on('data', (chunk) => {
    output += chunk.toString()
  })

  return {
    child,
    getOutput() {
      return output.trim()
    },
  }
}

async function isHttpReady(url) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }

    const req = http.get(url, { agent: false, headers: { Connection: 'close' } }, (res) => {
      const isReady = Boolean(res.statusCode) && res.statusCode < 500
      res.on('error', () => finish(false))
      res.on('end', () => finish(isReady))
      res.resume()
    })

    req.on('error', () => finish(false))
    req.setTimeout(1500, () => {
      req.destroy()
      finish(false)
    })
  })
}

async function waitForHttpReady(url, timeoutMs) {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (await isHttpReady(url)) {
      return true
    }

    await wait(250)
  }

  return false
}

async function ensureService(label, port, healthUrl, command, args) {
  const existingReady = await waitForHttpReady(healthUrl, 3000)
  if (existingReady) {
    console.log(`${label} is already running on port ${port}.`)
    return
  }

  const processInfo = startBackgroundProcess(command, args)
  const exitPromise = new Promise((resolve) => {
    processInfo.child.once('exit', (code, signal) => {
      resolve({ code, signal })
    })
  })

  const result = await Promise.race([
    waitForHttpReady(healthUrl, STARTUP_TIMEOUT_MS).then((ready) => ({ ready })),
    exitPromise.then((details) => ({ exited: details })),
  ])

  if (result.ready) {
    processInfo.child.stdout?.destroy()
    processInfo.child.stderr?.destroy()
    processInfo.child.unref()
    console.log(`${label} is ready on ${healthUrl}.`)
    return
  }

  const output = processInfo.getOutput()
  const details = result.exited
    ? `exit code ${result.exited.code ?? 'unknown'}`
    : `timed out after ${STARTUP_TIMEOUT_MS}ms`

  throw new Error(
    [
      `${label} failed to start (${details}).`,
      output ? `Output:\n${output}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  )
}

function assertPreflight() {
  if (!existsSync(webTtyPath)) {
    throw new Error(`Web TTY server not found: ${webTtyPath}`)
  }

  if (!existsSync(labPath)) {
    throw new Error(`Buddy lab entry not found: ${labPath}`)
  }

  ensureCommand(NODE_CMD, [], 'Node.js')
  ensureWebTtyDependencies()

  if (!existsSync(claudeConfigPath)) {
    throw new Error(
      [
        `Claude config not found: ${claudeConfigPath}`,
        'Open Claude Code once on this machine so it can create its local config, then try again.',
      ].join('\n'),
    )
  }

  resolveClaudePath()
}

async function main() {
  assertPreflight()

  await ensureService(
    'Claude Web TTY',
    WEB_TTY_PORT,
    `http://127.0.0.1:${WEB_TTY_PORT}/health`,
    NODE_CMD,
    [webTtyPath],
  )

  await ensureService(
    'Buddy Studio',
    LAB_PORT,
    `http://127.0.0.1:${LAB_PORT}/`,
    NODE_CMD,
    [labPath],
  )

  openBrowser(`http://127.0.0.1:${LAB_PORT}`)
  console.log(`Buddy Studio is ready: http://127.0.0.1:${LAB_PORT}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
