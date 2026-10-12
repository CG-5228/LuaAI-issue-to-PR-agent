// This file runs only from the trusted base branch. It never checks out PR code.
const POLICY_QUERY = `query EngineerMergePolicy($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id headRefOid reviewDecision mergeable
      baseRef { branchProtectionRule {
        requiresApprovingReviews requiredApprovingReviewCount dismissesStaleReviews
        requiresStatusChecks requiredStatusCheckContexts isAdminEnforced
      } }
    }
  }
}`;

// Shared path matching logic (must match src/verification.ts)
function isProtected(path, protectedPaths) {
  return protectedPaths.some(rule => {
    if (rule.endsWith('/')) {
      const dir = rule.slice(0, -1);
      return path === dir || path.startsWith(rule);
    }
    return path === rule || path.endsWith(`/${rule}`);
  });
}

function eligiblePr(pr, config) {
  return pr.state === 'open' && !pr.draft && pr.base.ref === config.baseBranch &&
    pr.head.repo?.full_name?.toLowerCase() === config.repository.toLowerCase() &&
    pr.base.repo?.full_name?.toLowerCase() === config.repository.toLowerCase() &&
    /^lua\/wf-[A-Za-z0-9_-]+$/.test(pr.head.ref) &&
    /<!-- lua-engineer:issue=([1-9][0-9]*) -->/.test(pr.body ?? '');
}

function classicProtectionAllows(rule, config) {
  return !!rule && rule.requiresApprovingReviews === true &&
    rule.requiredApprovingReviewCount >= config.minimumApprovals &&
    rule.dismissesStaleReviews === true && rule.isAdminEnforced === true &&
    rule.requiresStatusChecks === true &&
    config.requiredStatusChecks.every(name => rule.requiredStatusCheckContexts?.includes(name));
}

function rulesetProtectionAllows(rules, config) {
  const reviews = rules.filter(rule => rule.type === 'pull_request');
  const checks = rules.filter(rule => rule.type === 'required_status_checks');
  return reviews.some(rule => rule.parameters?.required_approving_review_count >= config.minimumApprovals &&
    rule.parameters?.dismiss_stale_reviews_on_push === true) &&
    config.requiredStatusChecks.every(name => checks.some(rule =>
      rule.parameters?.required_status_checks?.some(check => check.context === name)));
}

function currentHumanReviewers(reviews, pr) {
  // A comment does not erase an approval. A later request-changes or dismissal does.
  const latest = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state) && review.user) {
      latest.set(review.user.login, review);
    }
  }
  return [...latest.values()].filter(review => review.state === 'APPROVED' &&
    review.commit_id === pr.head.sha && review.user.type === 'User' &&
    review.user.login.toLowerCase() !== pr.user.login.toLowerCase()).map(review => review.user.login);
}

function requiredChecksPass(checkRuns, statuses, required) {
  const checks = new Map();
  for (const check of [...checkRuns].sort((a, b) => a.id - b.id)) checks.set(check.name, check);
  const latestStatuses = new Map();
  for (const status of [...statuses].sort((a, b) => a.id - b.id)) latestStatuses.set(status.context, status);
  return required.length > 0 && required.every(name => {
    const check = checks.get(name);
    const status = latestStatuses.get(name);
    if (check) return check.status === 'completed' && check.conclusion === 'success' && (!status || status.state === 'success');
    return status?.state === 'success';
  });
}

async function getReviewerPermissionsBatch(github, owner, repo, usernames) {
  // Batch permission checks to avoid N+1 API calls
  const permissions = {};
  for (const username of usernames) {
    try {
      const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
      permissions[username] = data.permission;
    } catch {
      permissions[username] = 'none';
    }
  }
  return permissions;
}

async function checkRulesetEnforcement(github, owner, repo, rules) {
  // Only active rules without bypass actors satisfy this automation's policy.
  const relevantRules = rules.filter(rule => ['pull_request', 'required_status_checks'].includes(rule.type));
  const ids = [...new Set(relevantRules.map(rule => rule.ruleset_id))];
  if (!ids.length || ids.some(id => !id)) throw new Error('Could not establish enforced ruleset IDs.');
  for (const rulesetId of ids) {
    const { data: ruleset } = await github.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', { owner, repo, ruleset_id: rulesetId });
    if (ruleset.enforcement !== 'active' || !Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length) {
      return false;
    }
  }
  return true;
}

async function mergeOne({ github, core, config, owner, repo, number }) {
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (!eligiblePr(pr, config)) return false;
  const issueNumber = Number(/<!-- lua-engineer:issue=([1-9][0-9]*) -->/.exec(pr.body)[1]);
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: issueNumber });
  if (issue.state !== 'open' || issue.pull_request || !issue.labels.some(label =>
    (typeof label === 'string' ? label : label.name) === config.issueLabel)) return false;
  const metadata = await github.graphql(POLICY_QUERY, { owner, repo, number });
  const decision = metadata.repository.pullRequest;
  if (decision.headRefOid !== pr.head.sha || decision.reviewDecision !== 'APPROVED' || decision.mergeable !== 'MERGEABLE') return false;

  let protectedBranch = classicProtectionAllows(decision.baseRef?.branchProtectionRule, config);
  if (!protectedBranch) {
    const { data: rules } = await github.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
      owner, repo, branch: config.baseBranch,
    });
    if (rulesetProtectionAllows(rules, config) && await checkRulesetEnforcement(github, owner, repo, rules)) {
      protectedBranch = true;
    }
  }
  if (!protectedBranch) throw new Error('The base branch needs enforced current-commit human reviews and the configured required CI checks.');

  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
  const reviewers = currentHumanReviewers(reviews, pr);
  if (reviewers.length < config.minimumApprovals) return false;

  // Batch permission checks to avoid N+1 API calls
  const permissions = await getReviewerPermissionsBatch(github, owner, repo, reviewers);
  const qualified = reviewers.filter(u => ['write', 'maintain', 'admin'].includes(permissions[u])).length;
  if (qualified < config.minimumApprovals) return false;

  const checkRuns = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: pr.head.sha, per_page: 100 });
  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, { owner, repo, ref: pr.head.sha, per_page: 100 });
  if (!requiredChecksPass(checkRuns, statuses, config.requiredStatusChecks)) return false;

  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 });
  if (!files.length || files.length > config.maxChangedFiles || files.some(file =>
    [file.filename, file.previous_filename].filter(Boolean).some(path => isProtected(path, config.protectedPaths)))) return false;

  // GitHub enforces its current branch rules too. The SHA prevents merging a new push
  // that raced with the review/check queries above. There is no admin bypass option.
  const { data: result } = await github.rest.pulls.merge({ owner, repo, pull_number: number, sha: pr.head.sha, merge_method: 'squash' });
  if (!result.merged) throw new Error(`GitHub declined to merge PR #${number}.`);
  core.info(`Merged human-approved PR #${number} at ${pr.head.sha}.`);
  return true;
}

async function run({ github, context, core, config }) {
  const { owner, repo } = context.repo;
  if (config.repository.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
      config.minimumApprovals < 1 || !config.requiredStatusChecks.length) throw new Error('Invalid merge policy.');
  const prs = context.payload.pull_request ? [context.payload.pull_request] :
    await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base: config.baseBranch, per_page: 100 });
  let merged = 0;
  for (const pr of prs.filter(pr => eligiblePr(pr, config)).slice(0, 20)) {
    try { if (await mergeOne({ github, core, config, owner, repo, number: pr.number })) merged++; }
    catch (error) { core.setFailed(`PR #${pr.number}: ${error.message}`); }
  }
  core.info(`Engineering merge scan completed: ${merged} merged.`);
}

module.exports = run;
module.exports.eligiblePr = eligiblePr;
module.exports.classicProtectionAllows = classicProtectionAllows;
module.exports.rulesetProtectionAllows = rulesetProtectionAllows;
module.exports.currentHumanReviewers = currentHumanReviewers;
module.exports.requiredChecksPass = requiredChecksPass;
module.exports.mergeOne = mergeOne;
