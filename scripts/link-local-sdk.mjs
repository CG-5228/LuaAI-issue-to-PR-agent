// Development helper for this workspace's preinstalled SDK, without network access.
import fs from 'node:fs/promises';
import path from 'node:path';
const sdk = path.resolve('../.tools/lua-cli/lib/node_modules/lua-cli');
await fs.access(path.join(sdk, 'package.json'));
await fs.mkdir('node_modules/@types', { recursive: true });
for (const [name, target] of [
  ['lua-cli', sdk], ['zod', path.join(sdk, 'node_modules/zod')],
  ['typescript', path.join(sdk, 'node_modules/typescript')],
  ['@types/node', path.join(sdk, 'node_modules/@types/node')],
]) {
  const destination = path.resolve('node_modules', name);
  try { await fs.symlink(target, destination); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
console.log('Linked the preinstalled Lua SDK for local verification.');
