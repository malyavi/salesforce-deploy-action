import {anchorTag, recordDeployed}                                                       from '../lib/anchor.mjs';
import {resolveConfig}                                                                   from '../lib/config.mjs';
import {error, group, setOutput, summary}                                                from '../lib/core.mjs';
import {buildDelta, isEmpty, resolveScope}                                               from '../lib/delta.mjs';
import {pruneDestructive, renderPruned}                                                  from '../lib/destructive.mjs';
import {failureMessage}                                                                  from '../lib/inputs.mjs';
import {summaryDelta, summaryFailed, summaryFull, summaryNothing, summarySucceeded}      from '../lib/report.mjs';
import {authenticate, clearActiveDeployment, deploy, registerActiveDeployment, teardown} from '../lib/salesforce.mjs';
import {installToolchain}                                                                from '../lib/toolchain.mjs';

/**
 * Deploys metadata to an org — what changed since the last deployment, or the
 * whole source directory when an org has to be seeded or resynced.
 *
 * The delta is built before the org is touched, so a push carrying no metadata
 * costs no login; and the anchor tag moves last, so it only ever records a
 * deployment that actually finished.
 */

/** The resolved configuration, for the signal handlers and the failure handler. */
let config = null;

let shuttingDown = false;

/**
 * Cancels the org-side deployment when the runner is taken away.
 *
 * @param {string} signal The signal received
 * @return {Promise<void>}
 */
async function handleSignal(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`\nReceived ${signal}. Cancelling the deployment…`);
  await teardown({orgAlias: config?.orgAlias, keyPath: config?.keyPath});
  process.exit(1);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => handleSignal(signal));
}

/**
 * Resolves the configuration, works out the scope, deploys it, records it.
 *
 * @return {Promise<void>}
 */
async function main() {
  config = await resolveConfig();
  if (config.cwd !== '.') {
    process.chdir(config.cwd);
  }

  if (config.installToolchain) {
    await group('Install the Salesforce CLI', () => installToolchain({
      ...config,
      needsDelta: config.mode === 'delta'
    }));
  }

  if (config.mode === 'full') {
    await deployFull();
    return;
  }
  await deployDelta();
}

/**
 * Deploys what changed since the last deployment.
 *
 * @return {Promise<void>}
 */
async function deployDelta() {
  const delta = await group('Build the delta manifest', () => buildDelta(config));
  await publishDelta(delta);

  if (isEmpty(delta)) {
    console.log('No deployable metadata changed; nothing to deploy.');
    // The org already matches this commit, so the anchor advances anyway —
    // otherwise every later delta keeps re-diffing from a commit that was
    // applied long ago, and grows for as long as nobody notices.
    const anchor = await advanceAnchor(delta.headSha);
    await summary(summaryNothing(config, delta, anchor));
    await publishOutcome('skipped', undefined, anchor);
    return;
  }

  await group('Authenticate to the org', () => authenticate(config));

  if (config.pruneDestructive && !delta.destructive.isEmpty) {
    const pruned = await group(
      'Check the deletions against the org',
      () => pruneDestructive(delta.destructive, config)
    );
    delta.destructive = pruned.manifest;
    await summary(summaryDelta(config, delta) + renderPruned(pruned));
    await publishDelta(delta);

    if (isEmpty(delta)) {
      console.log('Every change in this range is a deletion the org has already applied.');
      const anchor = await advanceAnchor(delta.headSha);
      await publishOutcome('skipped', undefined, anchor);
      return;
    }
  } else {
    await summary(summaryDelta(config, delta));
  }

  await send(resolveScope(delta, config), delta.headSha);
}

/**
 * Deploys the whole source directory.
 *
 * The bootstrap: a delta only carries what changed, so an org that has never
 * received the full tree fails on components no diff ever touches. Also the
 * way back after an org has drifted.
 *
 * @return {Promise<void>}
 */
async function deployFull() {
  const headSha = config.headSha || process.env.GITHUB_SHA;
  console.log(`Deploying all of ${config.sourceDir}/ — no delta.`);
  await summary(summaryFull(config, headSha));

  await group('Authenticate to the org', () => authenticate(config));
  await send(resolveScope({}, config), headSha);
}

/**
 * Runs the deployment and reports it.
 *
 * @param {{ args: string[], label: string }} scope What to deploy
 * @param {string|undefined} headSha The commit being deployed
 * @return {Promise<void>}
 */
async function send(scope, headSha) {
  const args = [
    ...scope.args,
    '--test-level', config.testLevel,
    ...config.tests.flatMap((name) => ['--tests', name]),
    '--wait', String(config.waitMinutes)
  ];

  let result;
  try {
    result = await deploy(args, {
      // `validate` is check-only: it runs the same tests and saves nothing.
      verb: config.checkOnly ? 'validate' : 'start',
      orgAlias: config.orgAlias,
      onJobId: (jobId) => registerActiveDeployment(jobId, config.orgAlias)
    });
  } catch (thrown) {
    await clearActiveDeployment();
    await summary(summaryFailed(config, scope, thrown.output ?? thrown.message));
    await publishOutcome('failed');
    throw thrown;
  }

  await clearActiveDeployment();

  const anchor = await advanceAnchor(headSha);
  await summary(summarySucceeded(config, scope, anchor));
  await publishOutcome('passed', result.deployId, anchor);
}

/**
 * Moves the anchor, and describes where it ended up.
 *
 * @param {string|undefined} sha The commit now deployed
 * @return {Promise<{ anchored: boolean, tag: string, sha: string }>} What the anchor records
 */
async function advanceAnchor(sha) {
  const tag = anchorTag(config);
  const anchored = await recordDeployed(sha, {
    tag,
    checkOnly: config.checkOnly,
    moveAnchor: config.moveAnchor
  });
  return {anchored, tag, sha: sha ?? ''};
}

/**
 * Publishes what the delta says, which is known before the org is involved.
 *
 * @param {object} delta The delta description
 * @return {Promise<void>}
 */
async function publishDelta(delta) {
  await setOutput('components', delta?.package?.componentCount ?? 0);
  await setOutput('deletions', delta?.destructive?.componentCount ?? 0);
  await setOutput('base-sha', delta?.baseSha ?? '');
  await setOutput('manifest-path', delta?.package?.path ?? '');
  await setOutput('destructive-path', delta?.destructive?.path ?? '');
}

/**
 * Publishes the verdict.
 *
 * @param {string} outcome `passed`, `failed` or `skipped`
 * @param {string} [deployId] The deployment's job id
 * @param {{ anchored: boolean, tag: string, sha: string }} [anchor] What the anchor records
 * @return {Promise<void>}
 */
async function publishOutcome(outcome, deployId, anchor) {
  await setOutput('outcome', outcome);
  await setOutput('deploy-id', deployId ?? '');
  await setOutput('anchor-tag', anchor?.tag ?? '');
  await setOutput('deployed-sha', anchor?.anchored ? anchor.sha : '');
}

try {
  await main();
} catch (thrown) {
  error(failureMessage(thrown));
  await setOutput('outcome', 'failed');
  process.exitCode = 1;
} finally {
  if (config?.logout) {
    await teardown({orgAlias: config.orgAlias, keyPath: config.keyPath});
  }
}
