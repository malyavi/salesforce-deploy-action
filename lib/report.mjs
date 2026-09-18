import {tail}               from './core.mjs';
import {renderDeltaSummary} from './manifest.mjs';

/**
 * What a reader is told. A deployment usually has no pull request to comment
 * on, so everything goes to the job summary — which is also the only record of
 * what reached the org, and is read after the fact rather than during.
 */

/** Lines of CLI output quoted when a run fails. */
export const FAILURE_LOG_LINES = 300;

/**
 * The directories a run covers, as markdown code spans.
 *
 * @param {{ sourceDirs: string[] }} config Resolved configuration
 * @return {string} For example `` `force-app/` and `malyavi-app/` ``
 */
function treeList(config) {
  return config.sourceDirs.map((dir) => `\`${dir}/\``).join(' and ');
}

/**
 * How a run names its target.
 *
 * @param {object} config Resolved configuration
 * @return {string} ` (production)`, or an empty string
 */
function target(config) {
  return config.environment ? ` (${config.environment})` : '';
}

/**
 * What the run is called: a check-only deployment is a validation, and calling
 * it a deployment in the summary is how somebody concludes the org changed.
 *
 * @param {object} config Resolved configuration
 * @return {string} `Deployment` or `Validation`
 */
export function verb(config) {
  return config.checkOnly ? 'Validation' : 'Deployment';
}

/**
 * The summary for a successful run.
 *
 * @param {object} config Resolved configuration
 * @param {{ label: string }} scope What was deployed
 * @param {{ anchored: boolean, tag: string, sha: string }} anchor What the anchor now records
 * @return {string} Markdown
 */
export function summarySucceeded(config, scope, anchor) {
  return [
    `## :white_check_mark: ${verb(config)} succeeded${target(config)}`,
    '',
    `Scope: ${scope.label}.`,
    `Apex test level: \`${config.testLevel}\``,
    ...(config.checkOnly
      ? ['', ':information_source: Check-only — nothing was saved to the org.']
      : []),
    ...(anchor.anchored ? ['', `\`${anchor.tag}\` now points at \`${anchor.sha.slice(0, 7)}\`.`] : [])
  ].join('\n');
}

/**
 * The summary for a failed run.
 *
 * @param {object} config Resolved configuration
 * @param {{ label: string }} scope What was being deployed
 * @param {string} output The CLI's output
 * @return {string} Markdown
 */
export function summaryFailed(config, scope, output) {
  return [
    `## :x: ${verb(config)} failed${target(config)}`,
    '',
    `Scope: ${scope.label}.`,
    '',
    '```',
    tail(output, FAILURE_LOG_LINES),
    '```'
  ].join('\n');
}

/**
 * The summary for a run with nothing to do.
 *
 * The anchor still moves, and that is the point of saying so: the org already
 * matches the commit, so leaving the anchor behind would make every later
 * delta re-diff from a commit that was applied long ago.
 *
 * @param {object} config Resolved configuration
 * @param {object} delta The delta description
 * @param {{ anchored: boolean, tag: string, sha: string }} anchor What the anchor now records
 * @return {string} Markdown
 */
export function summaryNothing(config, delta, anchor) {
  return [
    `## :white_check_mark: No metadata changes to deploy${target(config)}`,
    '',
    `Nothing under ${treeList(config)} differs from \`${delta.baseSha}\` (${delta.baseSource}).`,
    ...(anchor.anchored
      ? ['', `\`${anchor.tag}\` now points at \`${anchor.sha.slice(0, 7)}\`, so the next delta starts from here.`]
      : [])
  ].join('\n');
}

/**
 * The delta, for the summary of a run that has something to do.
 *
 * @param {object} config Resolved configuration
 * @param {object} delta The delta description
 * @return {string} Markdown
 */
export function summaryDelta(config, delta) {
  return renderDeltaSummary(delta, config);
}

/**
 * The summary for a full run, which has no delta to describe.
 *
 * @param {object} config Resolved configuration
 * @param {string} sha The commit being deployed
 * @return {string} Markdown
 */
export function summaryFull(config, sha) {
  return [
    `## :package: Full ${verb(config).toLowerCase()}${target(config)}`,
    '',
    `Every component under ${treeList(config)} at \`${sha ?? 'HEAD'}\`, not a delta.`
  ].join('\n');
}
