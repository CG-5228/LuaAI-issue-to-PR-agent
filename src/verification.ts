import type { EngineerConfig } from './config.ts';

export type CommandResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
export type RunCommand = (argv: string[]) => Promise<CommandResult>;
export type VerifiedChange = { branch: string; headSha: string; changedFiles: string[]; checks: string[] };

export function isProtected(path: string, protectedPaths: string[]): boolean {
  return protectedPaths.some(rule => rule.endsWith('/') ? path.startsWith(rule) :
    path === rule || path.endsWith(`/${rule}`));
}

export async function checked(exec: RunCommand, argv: string[]): Promise<CommandResult> {
  const result = await exec(argv);
  if (result.code !== 0 || result.timedOut) throw new Error(`Required command failed: ${argv.join(' ')}.`);
  return result;
}

export async function verifyChange(config: EngineerConfig, baseline: { baseSha: string; branch: string }, exec: RunCommand): Promise<VerifiedChange> {
  if (!/^[0-9a-f]{40,64}$/.test(baseline.baseSha)) throw new Error('Missing trusted checkout baseline.');
  const branch = (await checked(exec, ['git', 'branch', '--show-current'])).stdout.trim();
  if (branch !== baseline.branch || !/^lua\/wf-[A-Za-z0-9_-]+$/.test(branch)) {
    throw new Error('The checkout must remain on its Lua workflow branch.');
  }
  await checked(exec, ['git', 'merge-base', '--is-ancestor', baseline.baseSha, 'HEAD']);
  // Treat renames as deletion + addition so moving a protected file cannot hide it.
  const diff = await checked(exec, ['git', 'diff', '--no-renames', '--name-only', '-z', `${baseline.baseSha}...HEAD`]);
  const changedFiles = diff.stdout.split('\0').filter(Boolean);
  if (!changedFiles.length) throw new Error('The issue produced no committed changes.');
  if (changedFiles.length > config.maxChangedFiles) throw new Error('The change exceeds the configured file limit.');
  if (changedFiles.some(path => isProtected(path, config.protectedPaths))) {
    throw new Error('The change modifies protected repository instructions or automation.');
  }
  if ((await checked(exec, ['git', 'status', '--porcelain'])).stdout.trim()) {
    throw new Error('The agent must commit its changes before verification.');
  }
  const headSha = (await checked(exec, ['git', 'rev-parse', 'HEAD'])).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(headSha)) throw new Error('Invalid commit SHA.');
  for (const argv of config.installCommands) await checked(exec, argv);
  for (const check of config.checks) await checked(exec, check.argv);
  // Install/test scripts must not change the code that was just verified.
  if ((await checked(exec, ['git', 'rev-parse', 'HEAD'])).stdout.trim() !== headSha ||
      (await checked(exec, ['git', 'status', '--porcelain'])).stdout.trim()) {
    throw new Error('Verification changed the checkout. Commit the intended changes and verify again.');
  }
  return { branch, headSha, changedFiles, checks: config.checks.map(check => check.name) };
}
