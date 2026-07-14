import './claude_preload.js';

import { createRequire, syncBuiltinESMExports } from 'node:module';

const requireForProbe = createRequire(import.meta.url);
const crypto = requireForProbe('node:crypto');

const originalCreateHash = crypto.createHash;

function shortStack() {
  return String(new Error().stack || '')
    .split('\n')
    .slice(1, 8)
    .join('\n');
}

crypto.createHash = function patchedCreateHash(...args) {
  const hash = originalCreateHash.apply(this, args);
  const originalUpdate = hash.update;
  const originalDigest = hash.digest;
  let interestingInput = null;
  let interestingStack = null;

  hash.update = function patchedUpdate(data, ...rest) {
    if (interestingInput === null && typeof data === 'string' && data.includes('cch=00000')) {
      interestingInput = data;
      interestingStack = shortStack();
      console.error(`[cch-hash] update ${JSON.stringify({ algorithm: args[0], data, stack: interestingStack })}`);
    }
    return originalUpdate.call(this, data, ...rest);
  };

  hash.digest = function patchedDigest(...digestArgs) {
    const result = originalDigest.apply(this, digestArgs);
    if (interestingInput !== null) {
      const rendered = Buffer.isBuffer(result) ? result.toString('hex') : String(result);
      console.error(`[cch-hash] digest ${JSON.stringify({ algorithm: args[0], encoding: digestArgs[0] ?? null, digest: rendered, input: interestingInput, stack: interestingStack })}`);
    }
    return result;
  };

  return hash;
};

syncBuiltinESMExports();
