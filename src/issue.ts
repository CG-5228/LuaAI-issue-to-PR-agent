import type { EngineerConfig } from './config.ts';
import { assertConfigured } from './config.ts';
import type { GithubCall, Issue } from './github.ts';

/** Input for loading an issue. */
export type IssueInput = { repo: string; issueNumber: number };
/** Loaded issue with title, specification, and base branch. Includes truncation flag. */
export type LoadedIssue = IssueInput & { title: string; specification: string; baseBranch: string; truncated?: boolean };

/**
 * Load and validate an issue for the engineering workflow.
 * Checks that the issue is in the configured repo, is open, has the required label,
 * and doesn't already have an engineering PR open.
 *
 * @param input Issue input with repo and issue number.
 * @param config Engineer configuration.
 * @param api GitHub API call function.
 * @returns Loaded issue with title, specification, base branch, and truncation flag.
 * @throws If the issue is invalid, not in the configured repo, lacks the label, or has an existing PR.
 */
export async function loadIssue(input: IssueInput, config: EngineerConfig, api: GithubCall): Promise<LoadedIssue> {
  assertConfigured(config);
  if (input.repo !== config.repository) throw new Error('This coworker is restricted to its configured repository.');
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) throw new Error('Invalid issue number.');
  const issue = await api<Issue>({ method: 'GET', path: `repos/${config.repository}/issues/${input.issueNumber}` });
  if (issue.pull_request || issue.state !== 'open') throw new Error('Only open issues can be assigned.');
  if (!issue.labels.some(label => (typeof label === 'string' ? label : label.name) === config.issueLabel)) {
    throw new Error(`The issue must carry the ${config.issueLabel} label.`);
  }
  // A second run must not create another PR for an issue already under review.
  // No hardcoded page limit; paginate until we find the PR or exhaust results.
  for (let page = 1; ; page++) {
    const prs = await api<Array<{ body?: string | null }>>({
      method: 'GET', path: `repos/${config.repository}/pulls`,
      query: { state: 'open', per_page: 100, page },
    });
    if (prs.some(pr => pr.body?.includes(`<!-- lua-engineer:issue=${input.issueNumber} -->`))) {
      throw new Error('An engineering PR for this issue is already open. Review that PR first.');
    }
    if (prs.length < 100) break;
  }
  const fullTitle = issue.title ?? '';
  const fullSpec = issue.body ?? '';
  const truncated = fullTitle.length > 180 || fullSpec.length > 40000;
  return { ...input, title: fullTitle.slice(0, 180), specification: fullSpec.slice(0, 40000), baseBranch: config.baseBranch, truncated };
}
