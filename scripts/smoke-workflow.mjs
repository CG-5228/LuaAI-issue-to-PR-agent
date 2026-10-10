// Exercises the compiled Lua graph without calling a model, GitHub, or git push.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { engineerConfig as config } from '../dist/src/config.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const fixtureCommands = [['npm', 'ci'], ['npm', 'run', 'lint'], ['npm', 'test']];
if (JSON.stringify([...config.installCommands, ...config.checks.map(check => check.argv)]) !== JSON.stringify(fixtureCommands)) {
  throw new Error('This smoke fixture requires the default npm install/lint/test commands. Adapt the scratch fixture for customized target commands; npm test still covers the core behavior.');
}
const directory = await mkdtemp(join(tmpdir(), 'lua-engineer-graph-'));
function command(binary, argv, cwd = directory) {
  const result = spawnSync(binary, argv, { cwd, encoding: 'utf8', timeout: 60000,
    maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LUA_TELEMETRY: 'false' } });
  if (result.error) throw result.error;
  return result;
}
function git(...args) {
  const result = command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=LuaFixture', '-c', 'user.email=fixture@example.invalid', ...args]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
try {
  git('init', '-b', 'lua/wf-smoke');
  const pkg = { name: 'lua-engineer-smoke', version: '1.0.0', scripts: {
    lint: 'node --check index.cjs', test: 'node --test index.test.cjs',
  } };
  await writeFile(join(directory, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version,
    lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version } } }));
  await writeFile(join(directory, 'index.cjs'), 'module.exports = (a, b) => a - b;\n');
  await writeFile(join(directory, 'index.test.cjs'), "const assert = require('node:assert/strict'); assert.equal(require('./index.cjs')(2, 3), 5);\n");
  git('add', '.'); git('commit', '-m', 'Baseline');
  const baseSha = git('rev-parse', 'HEAD');
  const issue = { repo: config.repository, issueNumber: 7, title: 'Fix addition', specification: 'Return a + b.', baseBranch: config.baseBranch };
  async function runGraph(expectSuccess) {
    const sha = git('rev-parse', 'HEAD');
    const change = { branch: 'lua/wf-smoke', headSha: sha, changedFiles: ['index.cjs'], checks: config.checks.map(check => check.name) };
    const supplied = {
      getIssue: issue, checkout: { baseSha, branch: change.branch },
      implement: { summary: 'Fixed addition.', changedFiles: change.changedFiles },
      pushVerified: change,
      publishPr: { prNumber: 19, url: 'https://github.com/example/fixture/pull/19', headSha: sha, status: 'awaiting_human_review' },
    };
    const flags = Object.entries(supplied).flatMap(([id, value]) => ['--step-output', `${id}=${JSON.stringify(value)}`]);
    const result = command(process.execPath, ['node_modules/lua-cli/dist/index.js', 'test', '--ci', 'workflow',
      '--name', 'resolve-issue', '--input', JSON.stringify({ repo: issue.repo, issueNumber: 7 }),
      '--workspace', directory, '--json', ...flags], project);
    let output;
    try { output = JSON.parse(result.stdout); }
    catch { throw new Error(`Offline driver returned no JSON: ${result.stderr.slice(-2500)} ${result.stdout.slice(-2500)}`); }
    assert.equal(output.success, expectSuccess, JSON.stringify(output));
    if (expectSuccess) {
      assert.equal(result.status, 0);
      assert.equal(output.data.output.status, 'awaiting_human_review');
    } else {
      assert.notEqual(result.status, 0);
      assert.equal(output.data.error.stepId, 'verify');
    }
    console.log(`Offline graph: ${expectSuccess ? 'passing tests reach the PR output' : 'broken code stops at verification'}.`);
  }
  await writeFile(join(directory, 'index.cjs'), 'module.exports = (a, b) => a + b;\n');
  git('add', '.'); git('commit', '-m', 'Fix addition');
  await runGraph(true);
  await writeFile(join(directory, 'index.cjs'), 'module.exports = (a, b) => a * b;\n');
  git('add', '.'); git('commit', '-m', 'Regression');
  await runGraph(false);
} finally {
  await rm(directory, { recursive: true, force: true });
}
