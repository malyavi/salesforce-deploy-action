import {run}                            from './exec.mjs';
import {fetchDeployReport, newDeployId} from './salesforce.mjs';
import {
  ageInDays,
  isExpired,
  readValidationRecord,
  validationTag,
  VALIDATION_MAX_AGE_DAYS
}                                       from './validation-record.mjs';

/**
 * Deciding whether a recorded validation can stand in for this deployment.
 *
 * The bar is *the same package*: the same two trees at the ends of the delta,
 * the same directories diffed, the same treatment of deletions and whitespace,
 * at least the tests this deployment would run, and young enough for the org
 * to still honour it. Anything short of that deploys afresh and says why, in
 * the log and in the summary — a quick deploy that was silently not taken
 * would leave somebody wondering why the run took thirty minutes.
 *
 * Everything here answers a question; nothing here touches the org's
 * metadata. The deployment itself stays in the script.
 */

/**
 * Test levels from weakest to strongest. A validation stands in for a
 * deployment only when it ran at least the tests the deployment asks for.
 */
const TEST_LEVEL_RANK = ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'];

/**
 * The tree a commit points at.
 *
 * Read from git rather than the API: the delta needed the full history on
 * disk already, and a local answer cannot be rate limited.
 *
 * @param {string} sha Commit sha or ref
 * @return {Promise<string|null>} The tree's sha, or null when the commit is not on disk
 */
export async function treeOf(sha) {
  if (!sha) {
    return null;
  }
  try {
    const output = await run('git', ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`], {echo: false, capture: true});
    return output.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Looks for a validation that covers exactly this delta.
 *
 * @param {{ baseSha: string, headSha: string }} delta The delta description
 * @param {object} config Resolved configuration
 * @param {{ tree?: typeof treeOf, read?: typeof readValidationRecord, now?: number }} [seams] The git and API reads, and the current time, for testing
 * @return {Promise<{ tag: string, record: object }|{ tag: string, reason: string }>} The validation to promote, or why there is none
 */
export async function findValidation(delta, config, seams = {}) {
  const {tree = treeOf, read = readValidationRecord, now = Date.now()} = seams;

  const headTree = await tree(delta.headSha);
  const baseTree = await tree(delta.baseSha);
  if (!headTree || !baseTree) {
    return {tag: '', reason: 'the trees at the ends of the delta could not be read from git'};
  }

  const tag = validationTag(config.validationTagPrefix, config.environment, headTree);
  const record = await read(tag);
  if (!record) {
    return {tag, reason: `no validation is recorded for this tree (\`${tag}\`)`};
  }

  const reason = mismatch(record, {baseTree}, config, now);
  if (reason) {
    return {tag, reason: `validation \`${record.deployId}\` (\`${tag}\`) ${reason}`};
  }
  return {tag, record};
}

/**
 * Why a record does not stand in for this delta, or null when it does.
 *
 * The head tree is already equal — the record was found by it — so what is
 * left is everything else that shapes the package.
 *
 * @param {object} record The record
 * @param {{ baseTree: string }} delta The tree the deployment diffs from
 * @param {{ sourceDirs: string[], destructive: string, ignoreWhitespace: boolean, testLevel: string }} config Resolved configuration
 * @param {number} [now] The current time, for testing
 * @return {string|null} The reason, phrased to follow the validation's name, or null
 */
export function mismatch(record, {baseTree}, config, now = Date.now()) {
  if (record.baseTree !== baseTree) {
    return 'diffed from a different tree than the one the org has, so its package is not this delta';
  }

  const same = (list) => [...list].sort().join(',');
  if (same(record.sourceDirs) !== same(config.sourceDirs)) {
    return `covered ${describeDirs(record.sourceDirs)} rather than ${describeDirs(config.sourceDirs)}`;
  }
  if (record.destructive !== config.destructive) {
    return `handled deletions as \`${record.destructive}\` rather than \`${config.destructive}\``;
  }
  if (Boolean(record.ignoreWhitespace) !== Boolean(config.ignoreWhitespace)) {
    return `${record.ignoreWhitespace ? 'ignored' : 'counted'} whitespace-only changes, and this deployment does not`;
  }

  if (TEST_LEVEL_RANK.indexOf(record.testLevel) < TEST_LEVEL_RANK.indexOf(config.testLevel)) {
    return `ran \`${record.testLevel}\`, and this deployment asks for \`${config.testLevel}\``;
  }

  if (isExpired(record, now)) {
    const age = ageInDays(record, now);
    return Number.isFinite(age)
      ? `is ${Math.floor(age)} days old, and the org keeps a validation for ${VALIDATION_MAX_AGE_DAYS}`
      : 'carries no readable date';
  }
  return null;
}

/**
 * Checks the validation in the org before trusting the record: it has to be
 * there, be a validation, and have succeeded.
 *
 * The record says what was validated; only the org says whether it still
 * holds the result — and whether the org this run deploys to is the org the
 * validation ran in, which nothing in a repository can promise.
 *
 * @param {string} deployId The validation's job id
 * @param {string} orgAlias The org to ask
 * @param {{ report?: typeof fetchDeployReport }} [seams] The CLI call, for testing
 * @return {Promise<string|null>} Why the org would not honour it, or null when it would
 */
export async function verifyValidation(deployId, orgAlias, {report = fetchDeployReport} = {}) {
  const result = (await report(deployId, orgAlias))?.result;
  if (!result) {
    return `the org has no record of validation \`${deployId}\` — it may have run against another org`;
  }
  if (result.checkOnly !== true) {
    return `\`${deployId}\` is a deployment, not a validation`;
  }
  if (result.status !== 'Succeeded') {
    return `the org reports validation \`${deployId}\` as ${result.status ?? 'unfinished'}`;
  }
  return null;
}

/**
 * Whether a failed quick deploy got as far as starting a deployment.
 *
 * The CLI prints the *new* deployment's id once the org accepts the request,
 * so a transcript with no id but the validation's own is a refusal — the
 * validation expired, or the org would not promote it — and the delta can
 * still be deployed afresh. A transcript with a new id is a deployment that
 * ran and failed, which is a verdict.
 *
 * @param {string|undefined} output The CLI's transcript
 * @param {string} validationId The validation's job id, which the transcript may echo
 * @return {boolean} True when a deployment was started
 */
export function startedDeployment(output, validationId) {
  return Boolean(newDeployId(output, validationId));
}

/**
 * Directories, as a reader would list them.
 *
 * @param {string[]} dirs Directory names
 * @return {string} `` `force-app/` and `malyavi-app/` ``
 */
function describeDirs(dirs) {
  return dirs.map((dir) => `\`${dir}/\``).join(' and ');
}
