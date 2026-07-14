/*
 * Custom logic executed inside Claude Code's own Bun JavaScript runtime.
 *
 * Returning a new { input, init } from beforeFetch changes the request.
 * Returning a new { command, options } from beforeSpawn changes the process.
 * Leave callbacks empty to observe without changing Claude's behavior.
 */
export const hooks = {
  onReady(info) {
    console.error(`[claude-preload] active pid=${info.pid} version=${info.version}`);
  },

  async beforeFetch(context) {
    // Do not print headers here unless you explicitly want to expose tokens.
    if (process.env.CLAUDE_HOOK_LOG_FETCH === '1') {
      console.error(`[fetch:start] ${context.method} ${context.url}`);
    }
    return context;
  },

  async afterFetch(context) {
    // The response body is intentionally not consumed or cloned.
    if (process.env.CLAUDE_HOOK_LOG_FETCH === '1') {
      console.error(`[fetch:end] ${context.status ?? 'ERR'} ${context.url} ${context.durationMs}ms`);
    }
  },

  beforeSpawn(context) {
    if (process.env.CLAUDE_HOOK_LOG_SPAWN === '1') {
      console.error(`[spawn] ${JSON.stringify(context.command)}`);
    }
    return context;
  },

  afterSpawn(context) {
    // console.error(`[spawn] pid=${context.pid ?? 'sync'}`);
  },

  onExit(context) {
    // console.error(`[exit] code=${context.code}`);
  },
};

/*
 * Functions reachable through an object path or a real module export can be
 * wrapped precisely with Proxy. Arguments, returns, Promise settlement, and
 * exceptions are written to stderr as `[method-trace]` JSON lines.
 *
 * Module example:
 *   { module: 'node:fs', path: 'readFile', label: 'fs.readFile' }
 *
 * Prototype example:
 *   { object: 'globalThis', path: 'Response.prototype.json' }
 */
export const traceTargets = [];

/*
 * Unified outbound network tracing. Request bodies are recorded, while
 * authorization/cookie/token fields are redacted by default. Logs are JSONL.
 */
export const networkTrace = {
  enabled: true,
  // Leave undefined to use CLAUDE_NETWORK_TRACE_DIR, XDG_STATE_HOME, or
  // ~/.local/state/trace-claude-code.
  directory: undefined,
  maxBodyBytes: 2 * 1024 * 1024,
  maxSocketWriteBytes: 256 * 1024,
  captureSocketWrites: false,
  redactSecrets: true,
  stderr: false,
};
