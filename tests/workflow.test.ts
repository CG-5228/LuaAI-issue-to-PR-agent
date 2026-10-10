import test from 'node:test';
import assert from 'node:assert/strict';
import { engineerConfig, assertConfigured } from '../src/config.ts';
import { FABLE_MODEL } from '../src/model.ts';
import { loadIssue } from '../src/issue.ts';
import { verifyChange, type RunCommand } from '../src/verification.ts';
import { publishPullRequest } from '../src/publish.ts';
import type { GithubCall } from '../src/github.ts';

const config = { ...engineerConfig, repository: 'acme/app', baseBranch: 'main', issueLabel: 'lua-ready',
  minimumApprovals: 1, maxChangedFiles: 30,
  protectedPaths: ['.github/', '.lua/', '.agents/', '.codex/', 'AGENTS.md'],
  installCommands: [['npm', 'ci']],
  checks: [{ name: 'lint', argv: ['npm', 'run', 'lint'] }, { name: 'tests', argv: ['npm', 'test'] }],
  requiredStatusChecks: ['CI'] };
const sha = 'a'.repeat(40);
const baseline = { baseSha: 'b'.repeat(40), branch: 'lua/wf-abc' };
const issue = { repo: config.repository, issueNumber: 7, title: 'Fix login', specification: 'Handle expired sessions.', baseBranch: 'main' };
const change = { branch: baseline.branch, headSha: sha, changedFiles: ['src/login.ts'], checks: ['lint', 'tests'] };

function execFixture(options: { file?: string; fail?: string; timeout?: string; dirty?: boolean; changedHead?: boolean } = {}) {
  const calls: string[][] = [];
  let headReads = 0;
  const exec: RunCommand = async argv => {
    calls.push(argv);
    const command = argv.join(' ');
    let stdout = '';
    if (command === 'git branch --show-current') stdout = baseline.branch;
    if (argv[1] === 'diff') stdout = `${options.file ?? 'src/login.ts'}\0`;
    if (command === 'git rev-parse HEAD') stdout = options.changedHead && headReads++ ? 'c'.repeat(40) : sha;
    if (command === 'git status --porcelain' && options.dirty) stdout = ' M src/login.ts';
    return { code: command === options.fail ? 1 : 0, stdout, stderr: '', timedOut: command === options.timeout };
  };
  return { exec, calls };
}

test('Fable 5.1 is mandatory; alternative model settings are rejected', () => {
  assert.equal(FABLE_MODEL, 'anthropic/claude-fable-5-1');
  assert.doesNotThrow(() => assertConfigured(config));
  assert.throws(() => assertConfigured({ ...config, codingModel: 'auto' }), /Fable 5.1/);
});

test('placeholder repository and missing CI/review requirements cannot run', () => {
  assert.throws(() => assertConfigured({ ...config, repository: 'OWNER/REPOSITORY' }), /Set repository/);
  assert.throws(() => assertConfigured({ ...config, minimumApprovals: 0 }), /human approval/);
  assert.throws(() => assertConfigured({ ...config, requiredStatusChecks: [] }), /required GitHub/);
});

test('an issue must be in the configured repository', async () => {
  let called = false;
  const api = (async () => { called = true; }) as unknown as GithubCall;
  await assert.rejects(loadIssue({ repo: 'other/app', issueNumber: 7 }, config, api), /restricted/);
  assert.equal(called, false);
});

for (const [name, patch, message] of [
  ['closed issue', { state: 'closed' }, /open issues/],
  ['unlabelled issue', { labels: [] }, /lua-ready/],
  ['PR masquerading as issue', { pull_request: {} }, /open issues/],
] as const) {
  test(`${name} cannot start coding`, async () => {
    const api = (async () => Object.assign({ number: 7, title: 'Fix', body: '', state: 'open', labels: ['lua-ready'] }, patch)) as GithubCall;
    await assert.rejects(loadIssue({ repo: config.repository, issueNumber: 7 }, config, api), message);
  });
}

test('duplicate engineering PRs are detected beyond the first page', async () => {
  const api = (async request => request.path.endsWith('/issues/7') ?
    { number: 7, title: 'Fix', body: '', state: 'open', labels: ['lua-ready'] } :
    request.query?.page === 1 ? Array.from({ length: 100 }, () => ({ body: 'Other PR' })) :
    [{ body: '<!-- lua-engineer:issue=7 -->' }]) as GithubCall;
  await assert.rejects(loadIssue({ repo: config.repository, issueNumber: 7 }, config, api), /already open/);
});

test('verification independently runs installation and all configured checks', async () => {
  const { exec, calls } = execFixture();
  assert.deepEqual(await verifyChange(config, baseline, exec), change);
  assert.ok(calls.some(argv => argv.join(' ') === 'npm ci'));
  assert.ok(calls.some(argv => argv.join(' ') === 'npm run lint'));
  assert.ok(calls.some(argv => argv.join(' ') === 'npm test'));
  assert.equal(calls.some(argv => argv.includes('push')), false);
});

for (const [name, options, message] of [
  ['failing tests', { fail: 'npm test' }, /Required command failed/],
  ['timed out tests', { timeout: 'npm test' }, /Required command failed/],
  ['protected automation changes', { file: '.github/workflows/ci.yml' }, /protected/],
  ['nested repository instructions', { file: 'src/AGENTS.md' }, /protected/],
  ['uncommitted code', { dirty: true }, /commit its changes/],
  ['test scripts that change HEAD', { changedHead: true }, /Verification changed/],
] as const) {
  test(`${name} prevent publication`, async () => {
    await assert.rejects(verifyChange(config, baseline, execFixture(options).exec), message);
  });
}

test('remote changes after verification prevent PR creation', async () => {
  const methods: string[] = [];
  const api = (async request => { methods.push(request.method); return { object: { sha: 'c'.repeat(40) } }; }) as GithubCall;
  await assert.rejects(publishPullRequest(config, issue, change, 'Fixed.', api), /remote branch differs/);
  assert.deepEqual(methods, ['GET']);
});

test('publication reuses the existing matching PR without another write', async () => {
  const methods: string[] = [];
  const api = (async request => {
    methods.push(request.method);
    return request.path.includes('/git/ref/') ? { object: { sha } } : [{
      number: 19, html_url: 'https://github.com/acme/app/pull/19', head: { sha, ref: change.branch },
      base: { ref: 'main' }, body: '<!-- lua-engineer:issue=7 -->', state: 'open',
    }];
  }) as GithubCall;
  const result = await publishPullRequest(config, issue, change, 'Fixed.', api);
  assert.equal(result.prNumber, 19);
  assert.equal(result.status, 'awaiting_human_review');
  assert.deepEqual(methods, ['GET', 'GET']);
});
