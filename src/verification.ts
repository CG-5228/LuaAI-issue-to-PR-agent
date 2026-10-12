import type { EngineerConfig } from './config.ts';

/** Result of a command execution. */
export type CommandResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
/** Function that runs a command and returns its result. */
export type RunCommand = (argv: string[]) => Promise<CommandResult>;
/** Verified change metadata returned after successful verification. */
export type VerifiedChange = { branch: string; headSha: string; changedFiles: string[]; checks: string[] };

/**
 * Check if a path matches a pattern (directory prefix, glob, or exact).
 * Used for verificationIgnorePaths matching.
 */
function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith('/')) {
    const dir = pattern.slice(0, -1);
    return path === dir || path.startsWith(pattern);
  }
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(path);
  }
  return path === pattern || path.endsWith(`/${pattern}`);
}

/**
 * Check if a path is protected (should not be modified by the agent).
 * Directory rules (ending with /) match the directory itself and all nested paths.
 * File rules match the exact file or the file at any depth.
 */
export function isProtected(path: string, protectedPaths: string[]): boolean {
  return protectedPaths.some(rule => {
    if (rule.endsWith('/')) {
      const dir = rule.slice(0, -1);
      return path === dir || path.startsWith(rule);
    }
    return path === rule || path.endsWith(`/${rule}`);
  });
}

/**
 * Run a command and throw if it fails or times out.
 * @param exec The command executor function.
 * @param argv Command and arguments as an array.
 * @returns The command result.
 * @throws If the command exits with non-zero code or times out.
 */
export async function checked(exec: RunCommand, argv: string[]): Promise<CommandResult> {
  const result = await exec(argv);
  if (result.code !== 0 || result.timedOut) throw new Error(`Required command failed: ${argv.join(' ')}.`);
  return result;
}

/**
 * Verify that the changes in a git checkout are safe to publish.
 * Runs all configured install commands and checks, ensuring they pass and don't modify
 * the verified code (except for allowed test artifact paths).
 *
 * @param config Engineer configuration with checks, protected paths, etc.
 * @param baseline Baseline commit SHA and branch name from checkout step.
 * @param exec Command executor function.
 * @returns Verified change metadata including branch, head SHA, changed files, and passed checks.
 * @throws If verification fails (protected files modified, checks fail, unexpected changes, etc.).
 */
export async function verifyChange(config: EngineerConfig, baseline: { baseSha: string; branch: string }, exec: RunCommand): Promise<VerifiedChange> {
  if (!/^[0-9a-f]{40,64}$/.test(baseline.baseSha)) throw new Error('Missing trusted checkout baseline.');
  if (!/^lua\/wf-[A-Za-z0-9_-]+$/.test(baseline.branch)) throw new Error('Invalid baseline branch format.');
  const branch = (await checked(exec, ['git', 'branch', '--show-current'])).stdout.trim();
  if (branch !== baseline.branch || !/^lua\/wf-[A-Za-z0-9_-]+$/.test(branch)) {
    throw new Error('The checkout must remain on its Lua workflow branch.');
  }
  await checked(exec, ['git', 'merge-base', '--is-ancestor', baseline.baseSha, 'HEAD']);
  // Treat renames as deletion + addition so moving a protected file cannot hide it.
  // Use range diff (..) since baseline.baseSha is verified as ancestor of HEAD (line above).
  const diff = await checked(exec, ['git', 'diff', '--no-renames', '--name-only', '-z', `${baseline.baseSha}..HEAD`]);
  const changedFiles = diff.stdout.split('\0').filter(Boolean);
  if (!changedFiles.length) throw new Error('The issue produced no committed changes.');
  if (changedFiles.length > config.maxChangedFiles) throw new Error('The change exceeds the configured file limit.');
  // Validate no path traversal in changed files
  for (const path of changedFiles) {
    if (path.includes('..') || path.startsWith('/')) throw new Error(`Invalid file path in diff: ${path}`);
  }
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
  // Allow certain paths (e.g., test artifacts) to be modified during verification.
  const ignorePatterns = config.verificationIgnorePaths ?? [];
  const porcelain = (await checked(exec, ['git', 'status', '--porcelain'])).stdout.trim();
  const headAfter = (await checked(exec, ['git', 'rev-parse', 'HEAD'])).stdout.trim();
  if (headAfter !== headSha) {
    throw new Error('Verification changed the checkout (HEAD moved). Commit the intended changes and verify again.');
  }
  if (porcelain) {
    const modifiedPaths = porcelain.split('\n').map(line => line.slice(3).trim());
    const unexpected = modifiedPaths.filter(p => !ignorePatterns.some(pattern => matchesPattern(p, pattern)));
    if (unexpected.length) {
      throw new Error(`Verification changed the checkout (${unexpected.join(', ')}). Commit the intended changes and verify again.`);
    }
  }
  return { branch, headSha, changedFiles, checks: config.checks.map(check => check.name) };
}
