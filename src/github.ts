import { Integrations } from 'lua-cli';

export type GithubRequest = {
  method: 'GET' | 'POST' | 'PATCH'; path: string;
  query?: Record<string, string | number | boolean>; data?: unknown;
};
export type GithubCall = <T>(request: GithubRequest) => Promise<T>;

export async function githubCall<T>(request: GithubRequest): Promise<T> {
  const response = await Integrations.passthrough('github', request);
  if (response.status < 200 || response.status >= 300) {
    // Do not print the API body: it can contain private project data.
    throw new Error(`GitHub ${request.method} ${request.path} returned ${response.status}.`);
  }
  return response.data as T;
}

export type Issue = {
  number: number; title: string; body: string | null; state: string;
  labels: Array<string | { name?: string }>;
  pull_request?: unknown;
};
export type PullRequest = {
  number: number; html_url: string; head: { sha: string; ref: string };
  base: { ref: string }; body: string | null; state: string;
};
