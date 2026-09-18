import {run} from './exec.mjs';

/**
 * Installing the Salesforce CLI and the plugin that builds the delta.
 *
 * Both are installed globally rather than into the repository: the action does
 * not own the caller's `package.json`, and a repository that pins the CLI as a
 * dev dependency turns this step off with `install-toolchain: false`.
 */

/**
 * Installs the CLI and sfdx-git-delta.
 *
 * @param {{ cliVersion: string, sgdVersion: string, needsDelta: boolean }} options Versions to install, and whether the delta plugin is needed at all
 * @return {Promise<void>}
 */
export async function installToolchain({cliVersion, sgdVersion, needsDelta = true}) {
  await run('npm', ['install', '--global', '--no-fund', '--no-audit', versioned('@salesforce/cli', cliVersion)]);

  if (needsDelta) {
    // sfdx-git-delta is an unsigned third-party plugin, so the installer asks
    // for confirmation on stdin.
    await run('sf', ['plugins', 'install', versioned('sfdx-git-delta', sgdVersion)], {input: 'y\n'});
  }

  await run('sf', ['version', '--verbose']);
}

/**
 * A package specifier, with `latest` treated as the absence of a pin.
 *
 * @param {string} name Package name
 * @param {string} version Version, or `latest`
 * @return {string} The specifier to install
 */
export function versioned(name, version) {
  return `${name}@${version && version !== 'latest' ? version : 'latest'}`;
}
