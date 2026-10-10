import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineerConfig, assertConfigured } from '../dist/src/config.js';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const preview = process.argv.includes('--preview');
assertConfigured(preview && engineerConfig.repository === 'OWNER/REPOSITORY' ?
  { ...engineerConfig, repository: 'preview/preview' } : engineerConfig);
const destination = path.resolve(process.argv.slice(2).find(arg => arg !== '--preview') ?? path.join(project, 'target-repo'));
const control = path.join(destination, '.github/lua-engineer');
const workflows = path.join(destination, '.github/workflows');
await fs.mkdir(control, { recursive: true });
await fs.mkdir(workflows, { recursive: true });
for (const name of ['auto-merge.cjs', 'dispatch.cjs']) {
  await fs.copyFile(path.join(project, 'github', name), path.join(control, name));
}
await fs.writeFile(path.join(control, 'config.json'), JSON.stringify(engineerConfig, null, 2) + '\n');
const loadScript = name => `
            const {owner, repo} = context.repo;
            const repository = await github.rest.repos.get({owner, repo});
            const branch = await github.rest.repos.getBranch({owner, repo, branch: repository.data.default_branch});
            const ref = branch.data.commit.sha;
            const read = async path => {
              const {data} = await github.rest.repos.getContent({owner, repo, path, ref});
              if (Array.isArray(data) || data.type !== 'file' || data.encoding !== 'base64') throw new Error('Missing engineering control file.');
              return Buffer.from(data.content, 'base64').toString('utf8');
            };
            const config = JSON.parse(await read('.github/lua-engineer/config.json'));
            const module = {exports: {}};
            new Function('module', 'exports', await read('.github/lua-engineer/${name}.cjs'))(module, module.exports);
            await module.exports({github, context, core, config, env: process.env, fetch});`;
const action = 'actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd # v8';
await fs.writeFile(path.join(workflows, 'lua-engineer-dispatch.yml'), `name: Lua engineer - assign issue
on:
  issues:
    types: [labeled]
  workflow_dispatch:
    inputs:
      issue_number:
        description: Issue number with the engineering label
        required: true
        type: string
      attempt:
        description: Increase only to retry a failed or cancelled run
        required: true
        default: '1'
        type: string
permissions:
  contents: read
  issues: read
concurrency:
  group: lua-issue-\${{ github.event.issue.number || inputs.issue_number }}
  cancel-in-progress: false
jobs:
  assign:
    if: vars.LUA_ENGINEER_ENABLED == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - uses: ${action}
        env:
          LUA_API_KEY: \${{ secrets.LUA_API_KEY }}
          LUA_AGENT_ID: \${{ vars.LUA_AGENT_ID }}
        with:
          script: |${loadScript('dispatch')}
`);
await fs.writeFile(path.join(workflows, 'lua-engineer-merge.yml'), `name: Lua engineer - merge reviewed PRs
on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review]
permissions:
  contents: write
  pull-requests: write
  issues: read
  checks: read
  statuses: read
concurrency:
  group: lua-engineer-merges
  cancel-in-progress: false
jobs:
  merge:
    if: vars.LUA_ENGINEER_ENABLED == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      # No checkout: executable code and policy come from the trusted default branch.
      - uses: ${action}
        with:
          script: |${loadScript('auto-merge')}
`);
await fs.writeFile(path.join(control, 'branch-ruleset.json'), JSON.stringify({
  name: 'Engineering human review and CI', target: 'branch', enforcement: 'disabled', bypass_actors: [],
  conditions: { ref_name: { include: [`refs/heads/${engineerConfig.baseBranch}`], exclude: [] } },
  rules: [
    { type: 'pull_request', parameters: { required_approving_review_count: engineerConfig.minimumApprovals,
      dismiss_stale_reviews_on_push: true, require_code_owner_review: false, require_last_push_approval: true,
      required_review_thread_resolution: true } },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
      required_status_checks: engineerConfig.requiredStatusChecks.map(context => ({ context })) } },
    { type: 'non_fast_forward' },
  ],
}, null, 2) + '\n');
console.log(`Prepared target repository files in ${destination}. Nothing has been uploaded or enabled.`);
if (preview) console.log('Preview only: replace OWNER/REPOSITORY and regenerate before installation.');
