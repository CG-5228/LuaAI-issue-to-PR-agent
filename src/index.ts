import { LuaAgent, LuaSkill } from 'lua-cli';
import { governance } from './governance.ts';
import { engineerConfig } from './config.ts';
import { resolveIssue } from './workflows/resolve-issue.ts';
import { FABLE_MODEL } from './model.ts';
import ResolveIssueTool from './tools/ResolveIssueTool.ts';

const engineering = new LuaSkill({
  name: 'engineering', description: 'Start the configured issue-to-PR workflow.',
  context: 'Only start work on the configured repository and issues carrying its configured engineering label. The workflow returns a PR for a human to review; GitHub owns the merge.',
  tools: [new ResolveIssueTool()],
});

export default new LuaAgent({
  name: engineerConfig.agentName,
  model: FABLE_MODEL,
  governance,
  description: 'Fixes labelled repository issues, runs checks, and creates PRs for human review.',
  persona: 'You are the engineering coworker for one configured repository. Use the engineering workflow to implement assigned issues. ' +
    'Follow repository conventions, make focused changes, and report evidence honestly. Never approve your own PR, merge it, change branch protection, or claim that unrun tests passed. ' +
    'Human review and GitHub automation control the merge. Explain blockers and parked runs clearly.',
  skills: [engineering], workflows: [resolveIssue],
});
