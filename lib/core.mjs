import {appendFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

/**
 * Thin wrappers over the GitHub Actions workflow commands and file protocols,
 * so the action needs no `@actions/*` dependency and therefore no bundling step.
 * See https://docs.github.com/actions/reference/workflow-commands-for-github-actions
 *
 * Every function degrades to the console when the matching environment file is
 * absent, so a script can be run by hand outside a runner to debug it.
 */

/**
 * Tells the runner to redact `value` from every log line from here on.
 *
 * @param {string} value Value to redact from log output
 * @return {void}
 */
export function mask(value) {
  if (value) {
    console.error(`::add-mask::${value}`);
  }
}

/**
 * Emits an error annotation, which surfaces on the check itself.
 *
 * @param {string} message Error message to report
 * @return {void}
 */
export function error(message) {
  console.log(`::error::${escapeData(message)}`);
}

/**
 * Emits a warning annotation.
 *
 * @param {string} message Warning message to report
 * @return {void}
 */
export function warn(message) {
  console.log(`::warning::${escapeData(message)}`);
}

/**
 * Wraps `fn`'s log output in a collapsible group in the job log.
 *
 * @template T
 * @param {string} name Log group title
 * @param {() => Promise<T>|T} fn Async or sync function to execute in the group
 * @return {Promise<T>} Result of the function
 */
export async function group(name, fn) {
  console.log(`::group::${name}`);
  try {
    return await fn();
  } finally {
    console.log('::endgroup::');
  }
}

/**
 * Appends markdown to the job summary shown under the workflow run.
 *
 * @param {string} markdown Markdown text to append
 * @return {Promise<void>}
 */
export async function summary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) {
    console.log(markdown);
    return;
  }
  await appendFile(path, `${markdown}\n`, 'utf8');
}

/**
 * Publishes a step output, which the composite action re-exports as its own.
 * Values are stringified; booleans become 'true'/'false', which is what `if:`
 * expressions compare against.
 *
 * @param {string} name Output name
 * @param {unknown} value Output value
 * @return {Promise<void>}
 */
export async function setOutput(name, value) {
  const val = String(value ?? '');
  const path = process.env.GITHUB_OUTPUT;
  if (!path) {
    console.log(`[output] ${name}=${val}`);
    return;
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  await appendFile(path, `${name}<<${delimiter}\n${val}\n${delimiter}\n`, 'utf8');
}

/**
 * Saves state for a later step of the same job, through both the environment
 * file and the state file. The environment copy is what a plain `run:` step
 * sees; the state file is what a post-step of a JavaScript action would read.
 *
 * @param {string} name State property name
 * @param {unknown} value State property value
 * @return {Promise<void>}
 */
export async function saveState(name, value) {
  const val = String(value ?? '');
  process.env[`STATE_${name}`] = val;
  const delimiter = `ghadelimiter_${randomUUID()}`;

  const envPath = process.env.GITHUB_ENV;
  if (envPath) {
    await appendFile(envPath, `STATE_${name}<<${delimiter}\n${val}\n${delimiter}\n`, 'utf8');
  }

  const statePath = process.env.GITHUB_STATE;
  if (statePath) {
    await appendFile(statePath, `${name}<<${delimiter}\n${val}\n${delimiter}\n`, 'utf8');
  }
}

/**
 * Reads state saved by an earlier step of the same job.
 *
 * @param {string} name State property name
 * @return {string} State property value, or an empty string when unset
 */
export function getState(name) {
  return process.env[`STATE_${name}`] || '';
}

/**
 * Returns the last N lines of a string, which is where the reason for a failed
 * command is.
 *
 * @param {string} text Input text
 * @param {number} lines Maximum number of trailing lines to return
 * @return {string} The trailing lines
 */
export function tail(text, lines) {
  return String(text ?? '').trimEnd().split('\n').slice(-lines).join('\n');
}

/**
 * Removes ANSI colour codes, which test and lint reporters embed in failure
 * messages and which render as noise in markdown.
 *
 * @param {string} text Text that may carry escape sequences
 * @return {string} The plain text
 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\[[0-9;]*m/g, '');
}

/**
 * Escapes special characters for the workflow command data protocol.
 *
 * @param {unknown} value Value to escape
 * @return {string} Escaped string representation
 */
function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
