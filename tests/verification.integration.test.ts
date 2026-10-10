import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { engineerConfig } from '../src/config.ts';
import { verifyChange, type RunCommand } from '../src/verification.ts';

const execute = promisify(execFile);

test('real checkout verification runs tests and blocks protected-file renames and broken code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lua-engineer-verification-'));
  const childEnvironment = { ...process.env };
  // The outer node:test worker marker must not turn a repo's test command into a worker.
  delete childEnvironment.NODE_TEST_CONTEXT;
  const run: RunCommand = async argv => {
    try {
      const result = await execute(argv[0], argv.slice(1), { cwd: directory, timeout: 30000, env: childEnvironment });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
      return { code: typeof result.code === 'number' ? result.code : 1,
        stdout: result.stdout ?? '', stderr: result.stderr ?? '', timedOut: result.killed };
    }
  };
  const git = async (...args: string[]) => {
    const result = await run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
      '-c', 'user.name=LuaFixture', '-c', 'user.email=fixture@example.invalid', ...args]);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  const config = { ...engineerConfig, repository: 'acme/app', installCommands: [], maxChangedFiles: 30,
    protectedPaths: ['.github/', '.lua/', '.agents/', '.codex/', 'AGENTS.md'],
    checks: [{ name: 'syntax', argv: ['node', '--check', 'index.cjs'] },
      { name: 'tests', argv: ['node', '--test', 'index.test.cjs'] }] };
  try {
    await git('init', '-b', 'lua/wf-integration');
    await mkdir(join(directory, '.github/workflows'), { recursive: true });
    await writeFile(join(directory, '.github/workflows/fixture.yml'), 'name: trusted CI\n');
    await writeFile(join(directory, 'index.cjs'), 'module.exports = (a, b) => a - b;\n');
    await writeFile(join(directory, 'index.test.cjs'), "const assert = require('node:assert/strict'); assert.equal(require('./index.cjs')(2, 3), 5);\n");
    await git('add', '.');
    await git('commit', '-m', 'Baseline');
    const baseline = { baseSha: await git('rev-parse', 'HEAD'), branch: 'lua/wf-integration' };
    await writeFile(join(directory, 'index.cjs'), 'module.exports = (a, b) => a + b;\n');
    await git('add', '.');
    await git('commit', '-m', 'Fix addition');
    assert.deepEqual((await verifyChange(config, baseline, run)).checks, ['syntax', 'tests']);

    await mkdir(join(directory, 'docs'));
    await git('mv', '.github/workflows/fixture.yml', 'docs/fixture.yml');
    await git('commit', '-m', 'Move protected file');
    await assert.rejects(verifyChange(config, baseline, run), /protected/);

    const newBaseline = { ...baseline, baseSha: await git('rev-parse', 'HEAD') };
    await writeFile(join(directory, 'index.cjs'), 'module.exports = (a, b) => a - b;\n');
    await git('add', '.');
    await git('commit', '-m', 'Broken change');
    await assert.rejects(verifyChange(config, newBaseline, run), /Required command failed: node --test/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
