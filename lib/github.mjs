import {warn} from './core.mjs';

/**
 * The few GitHub REST calls these actions make, over `fetch`, so nothing has to
 * be installed or bundled.
 *
 * Every function answers null rather than throwing when the API is unavailable
 * or the environment is incomplete. A caller that needs an answer says so by
 * refusing on the null; one that has a local fallback — git, an input — takes
 * it. That keeps a token-less or rate-limited run from failing for a reason
 * unrelated to what it was checking.
 */

/**
 * Builds the GitHub REST request headers.
 *
 * @param {string} [userAgent] User-Agent identifying the caller in API logs
 * @return {Record<string, string>} Request headers
 */
function apiHeaders(userAgent = 'malyavi-actions') {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent
  };
}

/**
 * The repository the run is for, and whether it can be called at all.
 *
 * @return {{ repository: string, ok: boolean }} Repository in owner/repo form and whether a token and a repository are both present
 */
function context() {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  return {repository, ok: Boolean(process.env.GITHUB_TOKEN && repository)};
}

/**
 * Compares two commits or refs.
 *
 * @param {string} base Base ref or commit SHA
 * @param {string} head Head ref or commit SHA
 * @return {Promise<object|null>} The comparison, or null when it could not be read
 */
export async function compareCommits(base, head) {
  const {repository, ok} = context();
  if (!ok || !base || !head) {
    return null;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      {headers: apiHeaders()}
    );
    if (!response.ok) {
      warn(`Failed to compare ${base}...${head} (${response.status}): ${await response.text()}`);
      return null;
    }
    return await response.json();
  } catch (thrown) {
    warn(`Could not compare ${base}...${head}: ${thrown.message}`);
    return null;
  }
}

/**
 * Reads one commit.
 *
 * @param {string} commitSha Commit SHA or ref
 * @return {Promise<object|null>} The commit, or null when it could not be read
 */
export async function fetchCommit(commitSha) {
  const {repository, ok} = context();
  if (!ok || !commitSha) {
    return null;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/commits/${commitSha}`,
      {headers: apiHeaders()}
    );
    if (!response.ok) {
      warn(`Failed to read commit ${commitSha} (${response.status}): ${await response.text()}`);
      return null;
    }
    return await response.json();
  } catch (thrown) {
    warn(`Could not read commit ${commitSha}: ${thrown.message}`);
    return null;
  }
}

/**
 * Lists the files a pull request changed, across every page.
 *
 * @param {string|number} prNumber Pull request number
 * @return {Promise<Array<{ status: string, path: string }>|null>} Changed files with a git-style status, or null when they could not be read
 */
export async function fetchPullRequestFiles(prNumber) {
  const {repository, ok} = context();
  if (!ok || !prNumber) {
    return null;
  }

  const files = [];
  let page = 1;
  try {
    while (true) {
      const response = await fetch(
        `https://api.github.com/repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`,
        {headers: apiHeaders()}
      );
      if (!response.ok) {
        warn(`Failed to read the pull request's files (${response.status}): ${await response.text()}`);
        return null;
      }

      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        break;
      }
      files.push(...data.flatMap(normalizeFile));
      if (data.length < 100) {
        break;
      }
      page++;
    }
    return files;
  } catch (thrown) {
    warn(`Could not read the pull request's files: ${thrown.message}`);
    return null;
  }
}

/**
 * Lists the files a commit, or a range ending at it, changed.
 *
 * @param {string} commitSha Commit SHA or ref
 * @param {string} [baseSha] Base to compare against, for a range
 * @return {Promise<Array<{ status: string, path: string }>|null>} Changed files with a git-style status, or null when they could not be read
 */
export async function fetchCommitFiles(commitSha, baseSha) {
  const {repository, ok} = context();
  if (!ok || !commitSha) {
    return null;
  }

  try {
    const endpoint = baseSha && baseSha !== commitSha
      ? `https://api.github.com/repos/${repository}/compare/${baseSha}...${commitSha}`
      : `https://api.github.com/repos/${repository}/commits/${commitSha}`;

    const response = await fetch(endpoint, {headers: apiHeaders()});
    if (!response.ok) {
      warn(`Failed to read the commit's files (${response.status}): ${await response.text()}`);
      return null;
    }

    const data = await response.json();
    return (data.files || []).flatMap(normalizeFile);
  } catch (thrown) {
    warn(`Could not read the commit's files: ${thrown.message}`);
    return null;
  }
}

/**
 * Turns one API file entry into the git-style shape the callers use. A rename
 * becomes two entries, because the old path is a deletion as far as a metadata
 * manifest is concerned.
 *
 * @param {{ status: string, filename: string, previous_filename?: string }} file One API file entry
 * @return {Array<{ status: string, path: string }>} One entry, or two for a rename
 */
function normalizeFile(file) {
  const entries = [{status: mapApiStatus(file.status), path: file.filename}];
  if (file.status === 'renamed' && file.previous_filename) {
    entries.push({status: 'D', path: file.previous_filename});
  }
  return entries;
}

/**
 * Maps a GitHub API file status to the one-letter git status code.
 *
 * @param {string} apiStatus API status ('added', 'modified', 'removed', 'renamed', …)
 * @return {string} Status code ('A', 'M', 'D', …)
 */
export function mapApiStatus(apiStatus) {
  switch (apiStatus) {
    case 'added':
      return 'A';
    case 'removed':
      return 'D';
    case 'modified':
    case 'changed':
      return 'M';
    case 'renamed':
      return 'A';
    default:
      return apiStatus?.[0]?.toUpperCase() || 'M';
  }
}

/**
 * Reads the commit a lightweight tag points at.
 *
 * The tag name may contain slashes (`ci/deployed/main`), which are part of the
 * API path and must not be percent-encoded, or the route stops matching.
 *
 * @param {string} tag Tag name, without the `refs/tags/` prefix
 * @return {Promise<string|null>} Commit SHA, or null when the tag or the API is unavailable
 */
export async function fetchTag(tag) {
  const {repository, ok} = context();
  if (!ok || !tag) {
    return null;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/git/ref/tags/${tag}`,
      {headers: apiHeaders()}
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      warn(`Failed to read tag ${tag} (${response.status}): ${await response.text()}`);
      return null;
    }
    const data = await response.json();
    return data?.object?.sha ?? null;
  } catch (thrown) {
    warn(`Could not read tag ${tag}: ${thrown.message}`);
    return null;
  }
}

/**
 * Points a lightweight tag at a commit, creating it when it does not exist yet.
 *
 * Never throws: a caller uses this to record work that has already succeeded,
 * and a bookkeeping failure must not turn a green run red.
 *
 * @param {string} tag Tag name, without the `refs/tags/` prefix
 * @param {string} sha Commit SHA to point at
 * @return {Promise<boolean>} True when the tag now points at `sha`
 */
export async function moveTag(tag, sha) {
  const {repository, ok} = context();
  if (!ok || !tag || !sha) {
    return false;
  }

  const headers = apiHeaders();
  try {
    // force: the tag is a moving pointer, so this is a fast-forward by design.
    const update = await fetch(
      `https://api.github.com/repos/${repository}/git/refs/tags/${tag}`,
      {method: 'PATCH', headers, body: JSON.stringify({sha, force: true})}
    );
    if (update.ok) {
      return true;
    }
    // 404 is a tag that does not exist yet; 422 is the same answer from an
    // older API version. Anything else is a real refusal.
    if (update.status !== 404 && update.status !== 422) {
      warn(`Failed to move tag ${tag} (${update.status}): ${await update.text()}`);
      return false;
    }

    const create = await fetch(
      `https://api.github.com/repos/${repository}/git/refs`,
      {method: 'POST', headers, body: JSON.stringify({ref: `refs/tags/${tag}`, sha})}
    );
    if (!create.ok) {
      warn(`Failed to create tag ${tag} (${create.status}): ${await create.text()}`);
      return false;
    }
    return true;
  } catch (thrown) {
    warn(`Could not move tag ${tag}: ${thrown.message}`);
    return false;
  }
}
