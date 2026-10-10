import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const config = JSON.parse(await fs.readFile(new URL('../engineer.config.json', import.meta.url), 'utf8'));
const problems = [];
if (config.repository === 'OWNER/REPOSITORY') problems.push('Choose the target repository in engineer.config.json.');
if (config.codingModel !== 'anthropic/claude-fable-5-1') problems.push('The model must remain Fable 5.1.');
let manifest;
try { manifest = await fs.readFile(new URL('../lua.skill.yaml', import.meta.url), 'utf8'); }
catch { problems.push('Bind this project to a Lua agent with npm run lua -- init --agent-id <id>.'); }
if (manifest && !/agentId:\s*['"]?(?:agent_|baseAgent_)/.test(manifest)) problems.push('The project is not bound to a Lua agent yet.');
const auth = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', timeout: 15000 });
if (auth.status !== 0) problems.push('Authenticate GitHub CLI before checking repository configuration.');
if (!problems.length) {
  const metadata = spawnSync('gh', ['api', `repos/${config.repository}`], { encoding: 'utf8', timeout: 15000 });
  if (metadata.status !== 0) problems.push('GitHub repository could not be read.');
  else {
    const repo = JSON.parse(metadata.stdout);
    if (repo.default_branch !== config.baseBranch) problems.push('This first version requires baseBranch to be the repository default branch.');
    if (!repo.allow_squash_merge) problems.push('Enable squash merging for the repository.');
  }
}
if (!problems.length) {
  const sdk = fileURLToPath(new URL('../node_modules/lua-cli/dist/index.js', import.meta.url));
  const policy = spawnSync(process.execPath, [sdk, 'workflows', 'policy', 'models', 'get', '--json', '--ci'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, LUA_TELEMETRY: 'false' },
  });
  if (policy.status !== 0) problems.push('Could not verify the live Lua model policy; authenticate and verify it before activation.');
  else {
    try {
      const allow = JSON.parse(policy.stdout).data?.models?.allow;
      if (!Array.isArray(allow) || allow.length !== 1 || allow[0] !== config.codingModel) {
        problems.push('Lua workflow policy must allow only Fable 5.1 before activation. See the organization-scope note in README.md.');
      }
    } catch { problems.push('Lua returned an unreadable model policy.'); }
  }
}
if (problems.length) {
  console.log(problems.map(problem => `- ${problem}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('Repository, agent binding, and Fable-only workflow policy found. Check the review/CI policy in README.md before enabling LUA_ENGINEER_ENABLED.');
}
