import {mkdir}                         from 'node:fs/promises';
import {join}                          from 'node:path';
import {anchorTag, lastDeployedSha}    from './anchor.mjs';
import {run}                           from './exec.mjs';
import {fetchCommit, fetchCommitFiles} from './github.mjs';
import {ConfigError}                   from './inputs.mjs';
import {readManifest, splitManifest}   from './manifest.mjs';

/** The SHA a push event reports as `before` for a branch that did not exist. */
const EMPTY_SHA = '0000000000000000000000000000000000000000';

/**
 * Deciding what a deployment covers.
 */

/**
 * Resolves the commit to diff from, in the order of how much it can be trusted.
 *
 * 1. **The `base-sha` input.** The caller knows something this action does not.
 * 2. **The deployment anchor.** What the org actually has, which is the only
 *    base that cannot silently drift — see `lib/anchor.mjs`.
 * 3. **The push's own `before`.** Right whenever every previous run succeeded.
 * 4. **The target's first parent.** A last resort that at least deploys the
 *    commit in hand.
 *
 * @param {object} config Resolved configuration
 * @return {Promise<{ baseSha: string, headSha: string, baseSource: string }>} The range and how the base was found
 * @throws {ConfigError} When no base can be resolved at all
 */
export async function resolveRange(config) {
  const headSha = config.headSha || process.env.GITHUB_SHA;
  if (!headSha) {
    throw new ConfigError(
      'No commit to deploy. Pass `head-sha`, or run this where GITHUB_SHA is set.'
    );
  }

  if (config.baseSha) {
    return {baseSha: config.baseSha, headSha, baseSource: 'the `base-sha` input'};
  }

  const tag = anchorTag(config);
  const anchored = await lastDeployedSha(tag, headSha);
  if (anchored) {
    return {baseSha: anchored, headSha, baseSource: `the last deployment (${tag})`};
  }

  if (config.beforeSha && config.beforeSha !== EMPTY_SHA) {
    return {baseSha: config.beforeSha, headSha, baseSource: 'the previous commit on the branch'};
  }

  const parent = (await fetchCommit(headSha))?.parents?.[0]?.sha;
  if (parent) {
    return {baseSha: parent, headSha, baseSource: 'the first parent'};
  }

  throw new ConfigError(
    `Could not resolve a base commit for ${headSha}. Pass \`base-sha\`, or \`before-sha\` ` +
    'with the push event\'s own `before` value.'
  );
}

/**
 * Builds the delta manifests and reads them back.
 *
 * @param {object} config Resolved configuration
 * @return {Promise<object>} The delta: the range, the manifests, and how the base was chosen
 */
export async function buildDelta(config) {
  const {baseSha, headSha, baseSource} = await resolveRange(config);
  console.log(`Diffing ${baseSha}..${headSha} (${baseSource})`);

  await mkdir(config.deltaDir, {recursive: true});
  await run('sf', [
    'sgd', 'source', 'delta',
    '--from', baseSha,
    '--to', headSha,
    // One flag per directory: a repository with several package directories
    // needs one delta covering all of them, or the manifest it writes cannot
    // resolve a component that lives in the other one.
    ...config.sourceDirs.flatMap((dir) => ['--source-dir', dir]),
    '--output-dir', config.deltaDir,
    ...(config.ignoreWhitespace ? ['--ignore-whitespace'] : [])
  ]);

  const packageManifest = await readManifest(join(config.deltaDir, 'package/package.xml'));
  const destructiveManifest = await readManifest(
    join(config.deltaDir, 'destructiveChanges/destructiveChanges.xml')
  );
  const changes = await fetchCommitFiles(headSha, baseSha);
  const {added, modified} = splitManifest(packageManifest, changes || []);

  return {
    baseSha,
    headSha,
    baseSource,
    package: packageManifest,
    added,
    modified,
    destructive: destructiveManifest
  };
}

/**
 * Whether a delta has anything for the org to look at.
 *
 * @param {object} delta The delta description
 * @return {boolean} True when nothing changed
 */
export function isEmpty(delta) {
  return delta.package.isEmpty && delta.destructive.isEmpty;
}

/**
 * What to hand the deployment.
 *
 * One shape for a delta — the manifest, with the deletions attached — and one
 * for a full run, which is the source directory itself. A full run has no
 * delta to derive deletions from, so it carries none: it is a seed or a
 * resync, and deleting components a diff never mentioned is not part of either.
 *
 * @param {object} delta The delta description
 * @param {object} config Resolved configuration
 * @return {{ args: string[], label: string }} CLI arguments and a label for the summary
 */
export function resolveScope(delta, config) {
  if (config.mode === 'full') {
    return {
      args: config.sourceDirs.flatMap((dir) => ['--source-dir', dir]),
      label: `all of ${config.sourceDirs.map((dir) => `\`${dir}/\``).join(' and ')}`
    };
  }

  const args = ['--manifest', delta.package.path];
  if (!delta.destructive.isEmpty && config.destructive !== 'ignore') {
    args.push(
      config.destructive === 'pre' ? '--pre-destructive-changes' : '--post-destructive-changes',
      delta.destructive.path
    );
  }
  return {args, label: 'the delta'};
}
