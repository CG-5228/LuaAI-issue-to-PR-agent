import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { engineerConfig } from '../src/config.ts';
const require = createRequire(import.meta.url);
const merge = require('../../github/auto-merge.cjs');
const dispatch = require('../../github/dispatch.cjs');
const config = { ...engineerConfig, repository: 'acme/app', baseBranch: 'main', issueLabel: 'lua-ready',
  minimumApprovals: 1, maxChangedFiles: 30, requiredStatusChecks: ['CI'],
  protectedPaths: ['.github/', '.lua/', '.agents/', '.codex/', 'AGENTS.md'] };
const sha = 'a'.repeat(40);
const pr = { number: 19, state: 'open', draft: false, body: '<!-- lua-engineer:issue=7 -->',
  user: { login: 'engineer-bot' }, head: { sha, ref: 'lua/wf-abc', repo: { full_name: 'acme/app' } },
  base: { ref: 'main', repo: { full_name: 'acme/app' } } };
const rule = { requiresApprovingReviews: true, requiredApprovingReviewCount: 1, dismissesStaleReviews: true,
  requiresStatusChecks: true, requiredStatusCheckContexts: ['CI'], isAdminEnforced: true };
const humanReview = { id: 1, state: 'APPROVED', commit_id: sha, user: { login: 'human', type: 'User' } };
const passingCheck = { id: 1, name: 'CI', status: 'completed', conclusion: 'success' };

test('only ready PRs on this repository workflow branch qualify', () => {
  assert.equal(merge.eligiblePr(pr, config), true);
  assert.equal(merge.eligiblePr({ ...pr, draft: true }, config), false);
  assert.equal(merge.eligiblePr({ ...pr, head: { ...pr.head, repo: { full_name: 'fork/app' } } }, config), false);
  assert.equal(merge.eligiblePr({ ...pr, head: { ...pr.head, ref: 'main' } }, config), false);
});

test('required approvals, fresh reviews, CI and administrator enforcement are mandatory', () => {
  assert.equal(merge.classicProtectionAllows(rule, config), true);
  for (const patch of [{ requiredApprovingReviewCount: 0 }, { dismissesStaleReviews: false },
    { isAdminEnforced: false }, { requiredStatusCheckContexts: [] }]) {
    assert.equal(merge.classicProtectionAllows({ ...rule, ...patch }, config), false);
  }
});

test('bots, PR authors and approvals for an older commit never qualify as human review', () => {
  assert.deepEqual(merge.currentHumanReviewers([humanReview], pr), ['human']);
  for (const patch of [{ user: { login: 'bot', type: 'Bot' } },
    { user: { login: 'engineer-bot', type: 'User' } }, { commit_id: 'b'.repeat(40) }]) {
    assert.deepEqual(merge.currentHumanReviewers([{ ...humanReview, ...patch }], pr), []);
  }
});

test('requesting changes or dismissing a review invalidates the prior approval', () => {
  for (const state of ['CHANGES_REQUESTED', 'DISMISSED']) {
    assert.deepEqual(merge.currentHumanReviewers([humanReview, { ...humanReview, id: 2, state }], pr), []);
  }
  assert.deepEqual(merge.currentHumanReviewers([humanReview, { ...humanReview, id: 2, state: 'COMMENTED' }], pr), ['human']);
});

test('missing, failing, skipped, pending and superseded CI cannot pass the gate', () => {
  assert.equal(merge.requiredChecksPass([passingCheck], [], ['CI']), true);
  assert.equal(merge.requiredChecksPass([], [], ['CI']), false);
  for (const conclusion of ['failure', 'skipped', 'neutral', null]) {
    assert.equal(merge.requiredChecksPass([{ ...passingCheck, conclusion }], [], ['CI']), false);
  }
  assert.equal(merge.requiredChecksPass([passingCheck, { ...passingCheck, id: 2, status: 'in_progress', conclusion: null }], [], ['CI']), false);
});

function githubFixture(options: { reviews?: unknown[]; checks?: unknown[]; permission?: string; decision?: string; files?: string[] } = {}) {
  const writes: unknown[] = [];
  const reviewsEndpoint = () => {};
  const checksEndpoint = () => {};
  const statusesEndpoint = () => {};
  const filesEndpoint = () => {};
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pr }), listReviews: reviewsEndpoint, listFiles: filesEndpoint,
        merge: async (args: unknown) => { writes.push(args); return { data: { merged: true } }; } },
      issues: { get: async () => ({ data: { state: 'open', labels: ['lua-ready'] } }) },
      repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: options.permission ?? 'write' } }), listCommitStatusesForRef: statusesEndpoint },
      checks: { listForRef: checksEndpoint },
    },
    graphql: async () => ({ repository: { pullRequest: { headRefOid: sha, reviewDecision: options.decision ?? 'APPROVED',
      mergeable: 'MERGEABLE', baseRef: { branchProtectionRule: rule } } } }),
    paginate: async (endpoint: unknown) => endpoint === reviewsEndpoint ? options.reviews ?? [humanReview] :
      endpoint === checksEndpoint ? options.checks ?? [passingCheck] : endpoint === filesEndpoint ?
      (options.files ?? ['src/login.ts']).map(filename => ({ filename })) : [],
  };
  const core = { info: () => {} };
  return { github, core, config, owner: 'acme', repo: 'app', number: 19, writes };
}

test('merge uses the exact human-reviewed SHA and squash method', async () => {
  const fixture = githubFixture();
  assert.equal(await merge.mergeOne(fixture), true);
  assert.deepEqual(fixture.writes, [{ owner: 'acme', repo: 'app', pull_number: 19, sha, merge_method: 'squash' }]);
});

for (const [name, options] of [
  ['no approval', { reviews: [] }], ['CI failure', { checks: [{ ...passingCheck, conclusion: 'failure' }] }],
  ['read-only reviewer', { permission: 'read' }], ['changes requested', { decision: 'CHANGES_REQUESTED' }],
  ['automation modified', { files: ['.github/workflows/ci.yml'] }],
] as const) {
  test(`${name} makes no merge API call`, async () => {
    const fixture = githubFixture(options as Parameters<typeof githubFixture>[0]);
    assert.equal(await merge.mergeOne(fixture), false);
    assert.deepEqual(fixture.writes, []);
  });
}

test('issue dispatch uses the scoped Lua endpoint and a stable retry key', async () => {
  let request: { url: string; options: any } | undefined;
  const summary = { addHeading() { return this; }, addRaw() { return this; }, async write() {} };
  await dispatch({ config, context: { repo: { owner: 'acme', repo: 'app' }, actor: 'human', eventName: 'issues',
    payload: { issue: { number: 7 }, label: { name: 'lua-ready' } } },
    github: { rest: { repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: 'write' } }) },
      issues: { get: async () => ({ data: { state: 'open', labels: ['lua-ready'] } }) } } },
    core: { setOutput() {}, summary }, env: { LUA_API_KEY: 'test-only-key', LUA_AGENT_ID: 'agent_test' },
    fetch: async (url: string, options: unknown) => { request = { url, options }; return { ok: true, json: async () => ({ runId: 'wfr_test', status: 'queued' }) }; },
  });
  assert.equal(request!.url, 'https://api.heylua.ai/workflows/agent_test/runs');
  const body = JSON.parse(request!.options.body);
  assert.equal(body.idempotencyKey, 'issue:acme/app:7:attempt:1');
  assert.deepEqual(body.input, { repo: 'acme/app', issueNumber: 7 });
});
