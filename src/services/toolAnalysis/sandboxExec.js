/**
 * sandboxExec.js
 *
 * Every tool runner in services/toolAnalysis/runners/ executes against
 * user-submitted, UNTRUSTED code. This helper is the single choke point
 * all of them go through so we never run a raw `child_process.exec` with
 * no limits directly on the host process.
 *
 * Two execution modes:
 *   - `docker` (preferred, used when Docker is available): runs the
 *     command inside a locked-down, single-use container — no network,
 *     read-only repo mount, memory/CPU/pids caps, auto-removed after use.
 *   - `native` (fallback, used only if Docker isn't available in this
 *     environment): runs as a plain subprocess but still wrapped in
 *     `ulimit` resource caps and a hard wall-clock timeout via
 *     Promise.race, and the child process group is killed on timeout so
 *     nothing lingers.
 *
 * Neither mode ever runs a script *from* the repo itself (e.g. blindly
 * invoking package.json's "test" script) without this wrapper.
 */

const { spawn } = require('child_process')
const os = require('os')

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024 // 10MB stdout/stderr cap

let _dockerAvailable = null

async function isDockerAvailable() {
  if (_dockerAvailable !== null) return _dockerAvailable
  try {
    await runNative('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 3000 })
    _dockerAvailable = true
  } catch {
    _dockerAvailable = false
  }
  return _dockerAvailable
}

/**
 * Run `command args...` directly on the host, resource-capped.
 * Used either as the native fallback, or to invoke `docker run` itself
 * (docker run is host-trusted; what runs *inside* the container is not).
 */
function runNative(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd, maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  return new Promise((resolve, reject) => {
    // On Windows, npm-installed CLIs (npx, npm, and anything resolved through
    // them) are `.cmd` shim files, not real .exe binaries. `spawn()` without
    // `shell: true` can't resolve those and fails with ENOENT — while a real
    // .exe like docker.exe works fine. That's exactly why eslint/madge/depcheck
    // (all launched via npx) failed while gitleaks/jscpd/testCoverage (whose
    // native paths don't route through a bare `npx` spawn the same way) didn't.
    const useShell = os.platform() === 'win32'
    const child = spawn(command, args, {
      cwd,
      shell: useShell,
      // detached so we can kill the whole process group on timeout —
      // otherwise a tool that forks children (eslint, npx, etc.) can
      // outlive the timeout.
      detached: os.platform() !== 'win32',
      env: { ...process.env, CI: 'true' },
    })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        if (os.platform() !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {}
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`))
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString()
      else truncated = true
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString()
      else truncated = true
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, truncated })
    })
  })
}

/**
 * Run a tool command against a repo directory inside a sandbox.
 *
 * @param {string} image      Docker image to use (must already have the tool installed)
 * @param {string[]} command  Command + args to run *inside* the container
 * @param {string} repoPath   Absolute host path to the (already-extracted) repo, mounted read-only
 * @param {object} opts       { timeoutMs, memoryLimit, cpuLimit, network }
 */
async function runSandboxed(image, command, repoPath, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    memoryLimit = '512m',
    cpuLimit = '1',
    network = 'none', // untrusted code should never get network access
    writableTmp = true, // some tools (eslint autoconfig, jscpd/lizard reports) need to write output
  } = opts

  const dockerReady = await isDockerAvailable()

  if (dockerReady) {
    const args = [
      'run', '--rm',
      '--network', network,
      '--memory', memoryLimit,
      '--cpus', cpuLimit,
      '--pids-limit', '256',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '-v', `${repoPath}:/repo:ro`,
    ]
    if (writableTmp) args.push('-v', 'tool_scratch:/scratch', '-w', '/scratch')
    else args.push('-w', '/repo')
    args.push(image, ...command)

    return runNative('docker', args, { timeoutMs: timeoutMs + 5000 })
  }

  // ── Native fallback (no Docker in this environment) ──────────────────
  // Still resource-capped via `ulimit` (virtual memory + CPU seconds) and
  // a hard wall-clock timeout, on platforms that have a POSIX shell.
  // On Windows there's no `bash`/`ulimit` unless WSL or Git Bash happens
  // to be on PATH — spawning 'bash' there fails with ENOENT immediately,
  // which previously made every sandboxed tool fail identically before
  // ever reaching the real binary. Run the command directly there instead
  // (no ulimit caps available, but still wall-clock-timeout-capped by
  // runNative itself).
  if (os.platform() === 'win32') {
    const [cmd, ...rest] = command
    return runNative(cmd, rest, { timeoutMs, cwd: repoPath })
  }

  const cpuSeconds = Math.ceil(timeoutMs / 1000)
  const ulimitPrefix = [
    `ulimit -t ${cpuSeconds};`,
    `ulimit -v ${1024 * 1024 * 2};`, // ~2GB virtual memory cap
  ].join(' ')
  const shellCmd = `${ulimitPrefix} ${command.map(shellQuote).join(' ')}`
  return runNative('bash', ['-c', shellCmd], { timeoutMs, cwd: repoPath })
}

function shellQuote(s) {
  if (/^[a-zA-Z0-9_\-./:@=]+$/.test(s)) return s
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * Race a runner's promise against a hard timeout, resolving to a
 * standardized failure shape instead of throwing — callers always get
 * back an object, never an unhandled rejection, so Promise.allSettled in
 * the orchestrator never needs special-casing per tool.
 */
async function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { runNative, runSandboxed, isDockerAvailable, withTimeout }
