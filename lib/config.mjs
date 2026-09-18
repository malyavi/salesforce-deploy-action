import {readFile}                                                        from 'node:fs/promises';
import {tmpdir}                                                          from 'node:os';
import {join}                                                            from 'node:path';
import {booleanInput, ConfigError, input, intInput, listInput, rawInput} from './inputs.mjs';

/**
 * The action's inputs, resolved into one object.
 */

/** What a run deploys: only what changed, or the whole source directory. */
export const MODES = ['delta', 'full'];

/** Test levels the Metadata API accepts. */
export const TEST_LEVELS = ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'];

/** Where the delta manifests are written, under the working directory. */
export const DELTA_DIR = '.delta';

/**
 * Resolves every input.
 *
 * @return {Promise<object>} Resolved configuration
 * @throws {ConfigError} When a credential is incomplete or an input is malformed
 */
export async function resolveConfig() {
  const cwd = input('working-directory', '.');
  const orgAlias = input('org-alias', 'deploy-target');

  const mode = input('mode', 'delta').toLowerCase();
  if (!MODES.includes(mode)) {
    throw new ConfigError(`Unknown \`mode\` "${mode}"; expected one of ${MODES.join(', ')}.`);
  }

  const testLevel = input('test-level', 'RunLocalTests');
  if (!TEST_LEVELS.includes(testLevel)) {
    throw new ConfigError(`Unknown \`test-level\` "${testLevel}"; expected one of ${TEST_LEVELS.join(', ')}.`);
  }
  const tests = listInput('tests');
  if (testLevel === 'RunSpecifiedTests' && tests.length === 0) {
    throw new ConfigError('`test-level: RunSpecifiedTests` needs the `tests` input to name the classes to run.');
  }

  const destructive = input('destructive-changes', 'post').toLowerCase();
  if (!['post', 'pre', 'ignore'].includes(destructive)) {
    throw new ConfigError(`Unknown \`destructive-changes\` "${destructive}"; expected post, pre or ignore.`);
  }

  const config = {
    ...resolveCredentials(orgAlias),
    cwd,
    orgAlias,
    mode,
    checkOnly: booleanInput('check-only', false),
    sourceDirs: listInput('source-dirs', ['force-app']),
    baseSha: input('base-sha'),
    beforeSha: input('before-sha'),
    headSha: input('head-sha'),
    ignoreWhitespace: booleanInput('ignore-whitespace', true),
    destructive,
    pruneDestructive: booleanInput('prune-destructive', true),
    testLevel,
    tests,
    waitMinutes: intInput('wait-minutes', 30),
    apiVersion: input('api-version'),
    installToolchain: booleanInput('install-toolchain', true),
    cliVersion: input('sf-cli-version', 'latest'),
    sgdVersion: input('sgd-version', 'latest'),
    moveAnchor: booleanInput('move-anchor', true),
    tagPrefix: input('tag-prefix', 'ci/deployed'),
    anchorTag: input('anchor-tag'),
    environment: input('environment', process.env.GITHUB_REF_NAME ?? ''),
    logout: booleanInput('logout', true),
    label: input('label', 'Deployment'),
    // Relative, and they stay relative: the script changes into the working
    // directory once, so the CLI, git and every file read agree about where
    // they are without any of them being handed a directory.
    deltaDir: DELTA_DIR
  };

  config.apiVersion ||= await projectApiVersion(cwd);
  return config;
}

/**
 * Resolves the credential, and refuses an incomplete one by name.
 *
 * @param {string} orgAlias Alias the org is authenticated under, which names the key file
 * @return {{ authUrl: string, jwtKey: string, username: string, instanceUrl: string, clientId: string, keyPath: string }} Resolved credential
 * @throws {ConfigError} When neither credential shape is complete
 */
export function resolveCredentials(orgAlias) {
  const authUrl = rawInput('auth-url');
  const jwtKey = rawInput('jwt-key');
  const username = input('username');
  const clientId = input('client-id');
  const keyPath = join(process.env.RUNNER_TEMP || tmpdir(), `sf-auth-${orgAlias}.key`);

  if (authUrl) {
    return {authUrl, jwtKey: '', username, instanceUrl: '', clientId: '', keyPath};
  }

  const missing = [];
  if (!jwtKey) {
    missing.push('jwt-key');
  }
  if (!username) {
    missing.push('username');
  }
  if (!clientId) {
    missing.push('client-id');
  }
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing credential: ${missing.map((name) => `\`${name}\``).join(', ')}. ` +
      'Either pass those three for the JWT bearer flow, or pass `auth-url` alone for an sfdx auth URL.'
    );
  }

  return {
    authUrl: '',
    jwtKey,
    username,
    instanceUrl: input('instance-url', 'https://login.salesforce.com'),
    clientId,
    keyPath
  };
}

/**
 * The API version the project declares, for rewriting a manifest that carries
 * none of its own.
 *
 * @param {string} cwd Directory holding sfdx-project.json
 * @return {Promise<string>} The version, or an empty string when there is none
 */
export async function projectApiVersion(cwd) {
  try {
    const project = JSON.parse(await readFile(join(cwd, 'sfdx-project.json'), 'utf8'));
    return String(project.sourceApiVersion ?? '');
  } catch {
    return '';
  }
}
