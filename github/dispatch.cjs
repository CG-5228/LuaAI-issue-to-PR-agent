async function run({ github, context, core, config, env, fetch }) {
  const { owner, repo } = context.repo;
  if (config.repository.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) throw new Error('Wrong repository.');
  if (!env.LUA_API_KEY || !env.LUA_AGENT_ID) throw new Error('Configure LUA_API_KEY and LUA_AGENT_ID.');
  if (!/^agent_[A-Za-z0-9_-]+$/.test(env.LUA_AGENT_ID) && !/^baseAgent_[A-Za-z0-9_-]+$/.test(env.LUA_AGENT_ID)) throw new Error('Invalid Lua agent ID.');
  const actor = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: context.actor });
  if (!['write', 'maintain', 'admin'].includes(actor.data.permission)) throw new Error('Only repository maintainers may assign agent work.');
  if (context.eventName === 'issues' && context.payload.label?.name !== config.issueLabel) return;
  const issueNumber = Number(context.payload.issue?.number ?? context.payload.inputs?.issue_number);
  const attempt = Number(context.payload.inputs?.attempt ?? 1);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100) throw new Error('Invalid issue or attempt number.');
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  if (issue.state !== 'open' || issue.pull_request || !issue.labels.some(label =>
    (typeof label === 'string' ? label : label.name) === config.issueLabel)) throw new Error('The issue must be open and carry the engineering label.');
  const response = await fetch(`https://api.heylua.ai/workflows/${encodeURIComponent(env.LUA_AGENT_ID)}/runs`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.LUA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflowName: 'resolve-issue', input: { repo: config.repository, issueNumber },
      idempotencyKey: `issue:${config.repository}:${issueNumber}:attempt:${attempt}`,
      correlationKey: `issue:${config.repository}:${issueNumber}`, notify: 'app',
    }), signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) throw new Error(`Lua refused the workflow start (HTTP ${response.status}).`);
  const result = await response.json();
  if (!result.runId) throw new Error('Lua did not return a run ID.');
  core.setOutput('run_id', result.runId);
  await core.summary.addHeading(`Engineering issue #${issueNumber}`)
    .addRaw(`Lua run: ${result.runId}\nStatus: ${result.status}\n`).write();
}
module.exports = run;
