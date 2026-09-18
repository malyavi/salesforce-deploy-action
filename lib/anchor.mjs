import {compareCommits, fetchTag, moveTag} from './github.mjs';
import {warn}                              from './core.mjs';

/**
 * The tag that records what an environment actually has deployed.
 *
 * This is the piece that makes a delta deployment safe to build from. The
 * obvious base — the previous commit on the branch — answers a different
 * question: it says what was *pushed*, not what was *deployed*. The two
 * diverge the moment a run fails, is cancelled, or is filtered out by a
 * workflow's `paths:`, and from then on every later delta silently omits the
 * components that never made it, leaving the org behind the source with
 * nothing in any log to say so.
 *
 * A tag moved only on success cannot drift that way: the next delta always
 * starts from the last commit the org really received.
 */

/**
 * The anchor tag's name for an environment.
 *
 * @param {{ tagPrefix: string, environment: string, anchorTag: string }} config Resolved configuration
 * @return {string} Tag name, without the `refs/tags/` prefix
 */
export function anchorTag({tagPrefix, environment, anchorTag: explicit}) {
  if (explicit) {
    return explicit;
  }
  return environment ? `${tagPrefix}/${environment}` : tagPrefix;
}

/**
 * Reads the anchor, if it is safe to diff from.
 *
 * The tag is only usable when the target descends from it. After a force-push,
 * a branch reset, or a tag left behind by another branch, the anchor describes
 * history the target no longer contains and the diff would be meaningless — so
 * those cases fall through to whatever base the caller's event supplies, and
 * say so.
 *
 * @param {string} tag Tag name
 * @param {string} targetSha Commit being deployed
 * @return {Promise<string|null>} The anchor commit, or null to fall back
 */
export async function lastDeployedSha(tag, targetSha) {
  const anchorSha = await fetchTag(tag);
  if (!anchorSha) {
    console.log(`No ${tag} tag yet; falling back to the pushed commit range.`);
    return null;
  }

  // 'ahead' means the target is ahead of the anchor; 'identical' means the
  // commit is already deployed and the delta will simply be empty.
  const status = (await compareCommits(anchorSha, targetSha))?.status;
  if (status !== 'ahead' && status !== 'identical') {
    warn(
      `${tag} points at ${anchorSha}, which ${targetSha} does not descend from (${status ?? 'unknown'}). ` +
      'Falling back to the pushed commit range; run a full deployment if the org has drifted.'
    );
    return null;
  }

  console.log(`The last deployment was ${anchorSha} (${tag}).`);
  return anchorSha;
}

/**
 * Moves the anchor to the commit now live in the org.
 *
 * Bookkeeping only — a failure is warned about, never fatal, because the
 * deployment it records has already succeeded and failing the run would send
 * somebody to repair something that is not broken.
 *
 * @param {string|undefined} sha Commit now deployed
 * @param {{ tag: string, checkOnly: boolean, moveAnchor: boolean }} options The tag, and the two reasons not to move it
 * @return {Promise<boolean>} True when the tag now points at `sha`
 */
export async function recordDeployed(sha, {tag, checkOnly, moveAnchor}) {
  if (!moveAnchor) {
    return false;
  }
  if (checkOnly) {
    // Nothing reached the org, so the anchor would be claiming a deployment
    // that never happened — and the next real delta would start too late.
    console.log('Check-only run; leaving the deployment anchor where it is.');
    return false;
  }
  if (!sha) {
    warn('No target commit to anchor; the next delta will fall back to the pushed commit range.');
    return false;
  }

  if (await moveTag(tag, sha)) {
    console.log(`Anchored ${tag} at ${sha}.`);
    return true;
  }
  return false;
}
