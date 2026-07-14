/*
 * Put custom logic here. This file is concatenated before agent.js and runs
 * inside Frida's JavaScript runtime in the Claude Code process.
 *
 * Keep callbacks short. If a callback needs heavier work, queue it with
 * setImmediate() so the intercepted native thread can return quickly.
 */
globalThis.UserLogic = {
  onReady(info) {
    console.log(`[user] attached to ${info.path} @ ${info.base}`);
  },

  onDlopen(event) {
    // Example: observe native libraries loaded by Claude Code.
    // console.log(`[user] dlopen: ${event.path} => ${event.result}`);
  },

  onNapiRunScript(event) {
    // This fires only when a native addon calls napi_run_script(). Claude's
    // bundled application code normally uses the internal JSC evaluator.
    console.log(`[user] napi_run_script(env=${event.env}, value=${event.scriptValue})`);
  },

  onInternalEvaluate(event) {
    // Version-specific Bun/JSC evaluator hook. Arguments are opaque internal
    // objects; inspect first, and do not mutate them until their layouts are
    // fully understood.
    // console.log(`[user] internal evaluate from ${event.returnAddress}`);
  },

  onConnect(event) {
    // Example: observe outbound connections without changing them.
    // console.log(`[user] connect: ${JSON.stringify(event.address)}`);
  },
};
