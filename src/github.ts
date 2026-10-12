import { Integrations } from 'lua-cli';

/** Request shape for GitHub API calls. */
export type GithubRequest = {
  method: 'GET' | 'POST' | 'PATCH'; path: string;
  query?: Record<string, string | number | boolean>; data?: unknown;
};
/** Function type for making GitHub API calls. */
export type GithubCall = <T>(request: GithubRequest) => Promise<T>;

/**
 * Make a GitHub API call through the Lua integration.
 * Throws on non-2xx responses without exposing private data.
 *
 * @param request The GitHub API request.
 * @returns The parsed response data.
 * @throws If the API returns an error status.
 */
export async function githubCall<T>(request: GithubRequest): Promise<T> {
  const response = await Integrations.passthrough('github', request);
  if (response.status < 200 || response.status >= 300) {
    // Do not print the API body: it can contain private project data.
    throw new Error(`GitHub ${request.method} ${request.path} returned ${response.status}.`);
  }
  return response.data as T;
}

/** GitHub Issue shape (minimal fields used by the workflow). */
export type Issue = {
  number: number; title: string; body: string | null; state: string;
  labels: Array<string | { name: string }>;
  pull_request?: unknown;
};
/** GitHub Pull Request shape (minimal fields used by the workflow). */
export type PullRequest = {
  number: number; html_url: string; head: { sha: string; ref: string };
  base: { ref: string }; body: string | null; state: string;
};
