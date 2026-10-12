import type { EngineerConfig } from './config.ts';
import type { GithubCall, PullRequest } from './github.ts';
import type { LoadedIssue } from './issue.ts';
import type { VerifiedChange } from './verification.ts';

/**
 * Publish or reuse a pull request for the verified change.
 * Validates that the remote branch matches the verified commit, then creates a new PR
 * or reuses an existing matching PR.
 *
 * @param config Engineer configuration.
 * @param issue Loaded issue metadata.
 * @param change Verified change with branch, head SHA, changed files, and checks.
 * @param summary Implementation summary from the agent.
 * @param api GitHub API call function.
 * @returns PR metadata including number, URL, head SHA, and status.
 * @throws If the remote branch differs, multiple PRs exist, or PR doesn't match.
 */
export async function publishPullRequest(config: EngineerConfig, issue: LoadedIssue, change: VerifiedChange,
  summary: string, api: GithubCall): Promise<{ prNumber: number; url: string; headSha: string; status: string }> {
  if (issue.repo !== config.repository || issue.baseBranch !== config.baseBranch ||
      !/^lua\/wf-[A-Za-z0-9_-]+$/.test(change.branch)) throw new Error('Invalid PR target.');
  const ref = await api<{ object: { sha: string } }>({
    method: 'GET', path: `repos/${config.repository}/git/ref/heads/${change.branch}`,
  });
  if (ref.object.sha !== change.headSha) throw new Error('The remote branch differs from the verified commit.');
  const existing = await api<PullRequest[]>({
    method: 'GET', path: `repos/${config.repository}/pulls`,
    query: { state: 'open', head: `${config.repository.split('/')[0]}:${change.branch}`, base: config.baseBranch },
  });
  const marker = `<!-- lua-engineer:issue=${issue.issueNumber} -->`;
  if (existing.length > 1) throw new Error('More than one PR exists for this workflow branch.');
  if (existing.length && (!existing[0].body?.includes(marker) || existing[0].head.sha !== change.headSha)) {
    throw new Error('An existing PR does not match this issue and verified commit.');
  }
  const pr = existing[0] ?? await api<PullRequest>({
    method: 'POST', path: `repos/${config.repository}/pulls`,
    data: {
      title: `Fix #${issue.issueNumber}: ${issue.title}`.slice(0, 250),
      head: change.branch, base: config.baseBranch, draft: false,
      body: [marker, `Fixes #${issue.issueNumber}`, '', '## Changes', summary.slice(0, 6000), '',
        '## Validation', ...change.checks.map(check => `- Passed: ${check}`),
        `- Verified commit: \`${change.headSha}\``, '',
        'Human review is required. GitHub automation merges only an approved current commit with passing required checks.'
      ].join('\n'),
    },
  });
  return { prNumber: pr.number, url: pr.html_url, headSha: change.headSha, status: 'awaiting_human_review' };
}
