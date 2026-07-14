import { hooks, networkTrace, traceTargets } from './preload_user_logic.js';
import { installTraceTargets } from './method_proxy_trace.js';
import { installNetworkTrace } from './network_trace.js';

const STATE = Symbol.for('claude-code.custom-preload.state');

if (!globalThis[STATE]) {
  const state = {
    installedAt: Date.now(),
    originalFetch: globalThis.fetch,
    originalSpawn: globalThis.Bun?.spawn,
    originalSpawnSync: globalThis.Bun?.spawnSync,
  };
  globalThis[STATE] = state;

  function safeSync(name, payload, fallback) {
    const fn = hooks[name];
    if (typeof fn !== 'function') return fallback;
    try {
      return fn(payload) ?? fallback;
    } catch (error) {
      console.error(`[claude-preload] ${name} failed:`, error);
      return fallback;
    }
  }

  async function safeAsync(name, payload, fallback) {
    const fn = hooks[name];
    if (typeof fn !== 'function') return fallback;
    try {
      return (await fn(payload)) ?? fallback;
    } catch (error) {
      console.error(`[claude-preload] ${name} failed:`, error);
      return fallback;
    }
  }

  if (typeof state.originalFetch === 'function') {
    globalThis.fetch = async function hookedFetch(input, init) {
      const initial = {
        input,
        init,
        url: typeof input === 'string' || input instanceof URL ? String(input) : input?.url,
        method: init?.method || input?.method || 'GET',
      };
      const changed = await safeAsync('beforeFetch', initial, initial);
      const started = performance.now();
      try {
        const response = await state.originalFetch.call(globalThis, changed.input, changed.init);
        await safeAsync('afterFetch', {
          ...changed,
          response,
          status: response.status,
          durationMs: Math.round(performance.now() - started),
        });
        return response;
      } catch (error) {
        await safeAsync('afterFetch', {
          ...changed,
          error,
          durationMs: Math.round(performance.now() - started),
        });
        throw error;
      }
    };
  }

  if (globalThis.Bun && typeof state.originalSpawn === 'function') {
    globalThis.Bun.spawn = function hookedSpawn(command, options) {
      const initial = { command, options };
      const changed = safeSync('beforeSpawn', initial, initial);
      const subprocess = state.originalSpawn.call(globalThis.Bun, changed.command, changed.options);
      safeSync('afterSpawn', { ...changed, subprocess, pid: subprocess?.pid });
      return subprocess;
    };
  }

  if (globalThis.Bun && typeof state.originalSpawnSync === 'function') {
    globalThis.Bun.spawnSync = function hookedSpawnSync(command, options) {
      const initial = { command, options };
      const changed = safeSync('beforeSpawn', initial, initial);
      const result = state.originalSpawnSync.call(globalThis.Bun, changed.command, changed.options);
      safeSync('afterSpawn', { ...changed, result, pid: null });
      return result;
    };
  }

  state.networkTrace = installNetworkTrace(networkTrace);
  state.methodTraces = installTraceTargets(traceTargets);

  process.once('exit', code => safeSync('onExit', { code }));
  safeSync('onReady', {
    pid: process.pid,
    version: process.env.CLAUDE_TRACE_TARGET_VERSION || '2.1.204',
    runtime: `Bun ${globalThis.Bun?.version ?? 'unknown'}`,
    installedAt: state.installedAt,
  });
}
