import raw from '../engineer.config.json' with { type: 'json' };
import { FABLE_MODEL } from './model.ts';

// Plain JSON is included in the compiled Lua bundle. Change it before deploying.
export const engineerConfig = raw;
export type EngineerConfig = typeof engineerConfig;

export function assertConfigured(config: EngineerConfig): void {
  if (config.codingModel !== FABLE_MODEL) throw new Error('This coworker must use Fable 5.1.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) ||
      config.repository === 'OWNER/REPOSITORY') {
    throw new Error('Set repository in engineer.config.json before running the coworker.');
  }
  if (!config.baseBranch || /[\s~^:?*\[\\]/.test(config.baseBranch) ||
      config.baseBranch.startsWith('-') || config.baseBranch.includes('..')) {
    throw new Error('Invalid baseBranch.');
  }
  if (!config.checks.length || !config.requiredStatusChecks.length || config.minimumApprovals < 1) {
    throw new Error('Configure tests, required GitHub status checks, and at least one human approval.');
  }
  if (config.maxChangedFiles < 1 || !config.issueLabel) throw new Error('Invalid issue policy.');
  for (const command of [...config.installCommands, ...config.checks.map(check => check.argv)]) {
    if (!command.length || !['npm', 'pnpm', 'yarn', 'node', 'python3', 'pytest', 'make', 'npx'].includes(command[0])) {
      throw new Error('Commands must use a Lua Job-tier executable and an explicit argument array.');
    }
    if (command.some(arg => /\0|\n|\r/.test(arg))) throw new Error('Invalid command argument.');
  }
}
