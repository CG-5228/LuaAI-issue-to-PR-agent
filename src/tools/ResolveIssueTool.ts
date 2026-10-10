import { z } from 'zod';
import { Workflows, type LuaTool } from 'lua-cli';
import { engineerConfig, assertConfigured } from '../config.ts';
import { IssueInput } from '../workflows/resolve-issue.ts';

export default class ResolveIssueTool implements LuaTool {
  name = 'resolve_repository_issue';
  description = 'Implement a labelled issue and open a verified PR for human review. Increase attempt only to retry a failed or cancelled run.';
  inputSchema = IssueInput.extend({ attempt: z.number().int().min(1).max(100).default(1) });

  async execute(input: z.infer<typeof this.inputSchema>) {
    assertConfigured(engineerConfig);
    if (input.repo !== engineerConfig.repository) throw new Error('Repository not allowed.');
    return Workflows.start('resolve-issue', { repo: input.repo, issueNumber: input.issueNumber }, {
      idempotencyKey: `issue:${input.repo}:${input.issueNumber}:attempt:${input.attempt}`,
      correlationKey: `issue:${input.repo}:${input.issueNumber}`,
    });
  }
}
