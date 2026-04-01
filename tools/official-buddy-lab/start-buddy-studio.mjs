import { existsSync } from 'fs'
import { join } from 'path'
import { execSync, spawn } from 'child_process'

const workspace = process.cwd()
const webTtyPath = join(workspace, 'tools', 'claude-web-tty', 'server.js')
const labPath = join(workspace, 'scripts', 'official-buddy-lab.mjs')

function commandOutput(command) {
  return execSync(command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function isPortListening(port) {
  try {
    if (process.platform === 'win32') {
      const output = commandOutput(`cmd /c "netstat -ano | findstr :${port}"`)
      return output
        .split(/\r?\n/)
        .some((line) => /\bLISTENING\b/i.test(line))
    }

    if (process.platform === 'darwin') {
      return Boolean(commandOutput(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`))
    }

    return false
  } catch {
    return false
  }
}

function startDetached(command, args) {
  const child = spawn(command, args, {
    cwd: workspace,
    detached: true,
    stdio: 'ignore',
    shell: false,
  })
  child.unref()
}

if (!existsSync(webTtyPath)) {
  throw new Error(`Web TTY server not found: ${webTtyPath}`)
}

if (!existsSync(labPath)) {
  throw new Error(`Buddy lab entry not found: ${labPath}`)
}

if (!isPortListening(4322)) {
  startDetached('node', [webTtyPath])
}

spawn('node', [labPath], {
  cwd: workspace,
  stdio: 'inherit',
  shell: false,
})
