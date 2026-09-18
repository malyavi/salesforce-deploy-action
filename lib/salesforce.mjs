import {access, rm, writeFile} from 'node:fs/promises';
import {getState, mask, saveState} from './core.mjs';
import {run}                    from './exec.mjs';
import {ConfigError}            from './inputs.mjs';

/**
 * Talking to the org: logging in, running the deployment, and making sure the
 * credential and any unfinished job do not outlive the step.
 */

/** Salesforce deploy ids are 18 characters and start with the 0Af key prefix. */
export const DEPLOY_ID_PATTERN = /\b0Af[A-Za-z0-9]{15}\b/g;

/**
 * Normalises a private key into PEM text.
 *
 * Accepts a raw PEM or a base64-encoded one, because both are common ways to
 * paste a key into a repository secret — and a base64 blob pasted raw produces
 * an authentication failure that says nothing about the encoding.
 *
 * @param {string} key Raw PEM or base64-encoded private key
 * @return {string} PEM text with a trailing newline
 * @throws {ConfigError} When the value is neither
 */
export function toPem(key) {
  const pem = key.includes('-----BEGIN')
    ? key
    : Buffer.from(key.replace(/\s+/g, ''), 'base64').toString('utf8');

  if (!pem.includes('-----BEGIN')) {
    throw new ConfigError('The `jwt-key` input is not a PEM private key, raw or base64-encoded.');
  }
  return pem.endsWith('\n') ? pem : `${pem}\n`;
}

/**
 * Authenticates to the org and makes it the default for the rest of the step.
 *
 * Two ways in, because a repository has usually already chosen one: the JWT
 * bearer flow against a connected app, or an sfdx auth URL from
 * `sf org display --verbose`.
 *
 * @param {{ authUrl: string, jwtKey: string, username: string, instanceUrl: string, clientId: string, orgAlias: string, keyPath: string }} credentials Resolved credentials
 * @return {Promise<void>}
 */
export async function authenticate(credentials) {
  const {authUrl, jwtKey, username, instanceUrl, clientId, orgAlias, keyPath} = credentials;

  if (authUrl) {
    mask(authUrl);
    await writeFile(keyPath, authUrl.trim(), {mode: 0o600});
    await run('sf', ['org', 'login', 'sfdx-url', '--sfdx-url-file', keyPath, '--alias', orgAlias, '--set-default']);
    console.log(`Authenticated from an sfdx auth URL (${orgAlias})`);
    return;
  }

  // The consumer key is not a credential on its own, but keep it out of the
  // log so it stays redacted if it is ever moved into a secret.
  mask(clientId);
  await writeFile(keyPath, toPem(jwtKey), {mode: 0o600});

  await run('sf', [
    'org', 'login', 'jwt',
    '--client-id', clientId,
    '--jwt-key-file', keyPath,
    '--username', username,
    '--instance-url', instanceUrl,
    '--alias', orgAlias,
    '--set-default'
  ]);
  console.log(`Authenticated as ${username} at ${instanceUrl} (${orgAlias})`);
}

/**
 * Records the deployment now in flight, so that a cancelled job can still cancel
 * it in the org.
 *
 * A cancelled runner disappears; the org keeps validating for its full wait,
 * holding the deployment lock against every other run. The state is written to
 * the environment file so a later step of the same job can read it even though
 * this process is gone.
 *
 * @param {string} jobId Salesforce deployment job id
 * @param {string} orgAlias Org the deployment is running in
 * @return {Promise<void>}
 */
export async function registerActiveDeployment(jobId, orgAlias) {
  if (!jobId) {
    return;
  }
  await saveState('activeJobId', jobId);
  await saveState('activeOrgAlias', orgAlias);
}

/**
 * Clears the record once the deployment has finished one way or the other.
 *
 * @return {Promise<void>}
 */
export async function clearActiveDeployment() {
  await saveState('activeJobId', '');
  await saveState('activeOrgAlias', '');
}

/**
 * Cancels a deployment in the org.
 *
 * Never throws: it runs while something else is already going wrong.
 *
 * @param {string} jobId Salesforce deployment job id
 * @param {string} orgAlias Org the deployment is running in
 * @return {Promise<void>}
 */
export async function cancelDeployment(jobId, orgAlias) {
  if (!jobId) {
    return;
  }
  console.log(`Cancelling Salesforce deployment ${jobId} on ${orgAlias}…`);
  try {
    await run('sf', ['project', 'deploy', 'cancel', '--job-id', jobId, '--target-org', orgAlias, '--no-prompt']);
    console.log(`Requested cancellation of ${jobId}.`);
  } catch (thrown) {
    console.warn(`Could not cancel deployment ${jobId}: ${thrown.message}`);
  }
}

/**
 * Removes the credential from the runner, cancels any unfinished deployment,
 * and revokes the session.
 *
 * Idempotent and never throws — it runs from the script's own `finally` and
 * again from a step with `if: always()`, and must not turn a green run red.
 *
 * The key file doubles as the "did we authenticate?" marker: it is absent when
 * the run never logged in, and absent again once a previous teardown finished,
 * so the logout is attempted exactly when there is a session to revoke.
 *
 * @param {{ orgAlias: string, keyPath: string }} options The org and the key file
 * @return {Promise<void>}
 */
export async function teardown({orgAlias, keyPath}) {
  try {
    const jobId = getState('activeJobId');
    const target = getState('activeOrgAlias') || orgAlias;
    if (jobId) {
      await cancelDeployment(jobId, target);
    }
  } catch {
    // Nothing in flight, or no state to read.
  } finally {
    await clearActiveDeployment();
  }

  const authenticated = await access(keyPath).then(() => true, () => false);
  if (!authenticated) {
    return;
  }

  await rm(keyPath, {force: true}).catch(() => {});
  await run('sf', ['org', 'logout', '--target-org', orgAlias, '--no-prompt']).catch(() => {});
}

/**
 * Runs a deployment or a validation, watching its output for the job id.
 *
 * The id is read from the stream rather than from the final answer because the
 * point of having it is to cancel a run that never produces one.
 *
 * @param {string[]} args Arguments after `sf project deploy <verb>`
 * @param {{ verb: string, orgAlias: string, onJobId?: (jobId: string) => void }} options The verb to run, the org, and a callback for the job id
 * @return {Promise<{ output: string, deployId: string|undefined }>} The CLI's output and the job id it reported
 */
export async function deploy(args, {verb, orgAlias, onJobId}) {
  let jobId;
  const output = await run('sf', ['project', 'deploy', verb, '--target-org', orgAlias, ...args], {
    onStdout: (chunk, accumulated) => {
      if (jobId) {
        return;
      }
      const match = accumulated.match(DEPLOY_ID_PATTERN);
      if (match) {
        jobId = match.at(-1);
        onJobId?.(jobId);
      }
    }
  });
  return {output, deployId: output.match(DEPLOY_ID_PATTERN)?.at(-1) ?? jobId};
}

/**
 * The deploy id in a command's output, which is what a quick deploy is made
 * from.
 *
 * The *last* match, not the first: the CLI prints the id as it starts and again
 * as it finishes, and a retried request prints more than one.
 *
 * @param {string} output The CLI's output
 * @return {string|undefined} The job id, or undefined when it printed none
 */
export function deployIdFrom(output) {
  return String(output ?? '').match(DEPLOY_ID_PATTERN)?.at(-1);
}
