import type { EngineerConfig } from './config.ts';
import { assertConfigured } from './config.ts';
import type { GithubCall, Issue } from './github.ts';

export type IssueInput = { repo: string; issueNumber: number };
export type LoadedIssue = IssueInput & { title: string; specification: string; baseBranch: string };

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
  for (let page = 1; page <= 10; page++) {
    const prs = await api<Array<{ body?: string | null }>>({
      method: 'GET', path: `repos/${config.repository}/pulls`,
      query: { state: 'open', per_page: 100, page },
    });
    if (prs.some(pr => pr.body?.includes(`<!-- lua-engineer:issue=${input.issueNumber} -->`))) {
      throw new Error('An engineering PR for this issue is already open. Review that PR first.');
    }
    if (prs.length < 100) break;
    if (page === 10) throw new Error('Too many open PRs to establish that this issue has no engineering PR.');
  }
  return { ...input, title: issue.title.slice(0, 180), specification: (issue.body ?? '').slice(0, 40000), baseBranch: config.baseBranch };
}
