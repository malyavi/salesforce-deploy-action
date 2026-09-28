import {warn}                                                                       from './core.mjs';
import {createTagObject, deleteTag, fetchTagObject, fetchTagRef, listTags, moveTag} from './github.mjs';

/**
 * The record a passing validation leaves behind, so that a deployment of the
 * same change can be *promoted* from it — `sf project deploy quick` — instead
 * of running its tests a second time.
 *
 * A validation is a check-only deployment: the org compiles the package, runs
 * the tests, saves nothing, and keeps the result for ten days. In that window
 * the same package can be deployed by its job id alone, without the tests,
 * which for a production org with a long suite is most of the run. What has to
 * be established is that the package the deployment would build is *the same
 * package* — and a delta is a function of the two trees it is diffed between,
 * so that is what the record carries.
 *
 * The record is an annotated tag, `<prefix>/<environment>/<head tree>`, whose
 * message is JSON. Named by the **tree** rather than the commit on purpose: a
 * pull request is validated as its merge commit, which is never the commit
 * that lands on the branch — a squash, a rebase and a merge all produce a new
 * one — but every one of them produces the same tree as long as the base did
 * not move. A tree the deployment can look up is therefore exactly the check
 * that nothing changed since the validation.
 *
 * Both actions in this family ship this file unchanged: the one that writes
 * the record and the one that reads it have to agree about its shape.
 */

/** Salesforce keeps a validation eligible for a quick deploy for this long. */
export const VALIDATION_MAX_AGE_DAYS = 10;

/** Where the records live when the caller names no other prefix. */
export const DEFAULT_VALIDATION_TAG_PREFIX = 'ci/validated';

/** What a record has to carry to be one. */
const REQUIRED_FIELDS = ['deployId', 'validatedAt', 'baseSha', 'baseTree', 'headSha', 'headTree', 'sourceDirs', 'destructive', 'ignoreWhitespace', 'testLevel'];

/**
 * The namespace one environment's records live under.
 *
 * @param {string} prefix Tag prefix
 * @param {string} environment The environment, or an empty string for none
 * @return {string} `ci/validated/main`, or `ci/validated` with no environment
 */
export function validationNamespace(prefix, environment) {
  return environment ? `${prefix}/${environment}` : prefix;
}

/**
 * The tag that records a validation of one tree.
 *
 * @param {string} prefix Tag prefix
 * @param {string} environment The environment, or an empty string for none
 * @param {string} headTree The validated tree's sha
 * @return {string} Tag name, without the `refs/tags/` prefix
 */
export function validationTag(prefix, environment, headTree) {
  return `${validationNamespace(prefix, environment)}/${headTree}`;
}

/**
 * The record as it is written into the tag's message.
 *
 * @param {object} record The record
 * @return {string} JSON, one field per line
 */
export function renderRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Reads a record back out of a tag's message.
 *
 * Strict on purpose: a record missing a field is one a later version of the
 * writer did not produce, and a reader that guessed at the field would be
 * guessing about whether to skip the tests.
 *
 * @param {string|undefined} message The tag's message
 * @return {object|null} The record, or null when the message is not one
 */
export function parseRecord(message) {
  let record;
  try {
    record = JSON.parse(String(message ?? ''));
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return null;
  }
  if (REQUIRED_FIELDS.some((field) => record[field] === undefined || record[field] === null)) {
    return null;
  }
  if (!Array.isArray(record.sourceDirs)) {
    return null;
  }
  return record;
}

/**
 * How old a record is, in days.
 *
 * @param {{ validatedAt: string }} record The record
 * @param {number} [now] The current time, for testing
 * @return {number} Days since the validation, or Infinity when the date is unreadable
 */
export function ageInDays(record, now = Date.now()) {
  const validated = Date.parse(record?.validatedAt ?? '');
  if (Number.isNaN(validated)) {
    return Infinity;
  }
  return (now - validated) / (24 * 60 * 60 * 1000);
}

/**
 * Whether Salesforce will still promote this validation.
 *
 * @param {{ validatedAt: string }} record The record
 * @param {number} [now] The current time, for testing
 * @return {boolean} True when the record is older than the org keeps a validation for
 */
export function isExpired(record, now = Date.now()) {
  return ageInDays(record, now) > VALIDATION_MAX_AGE_DAYS;
}

/**
 * Writes a record: creates the tag object with the record as its message, and
 * points the tag at it — over whatever a previous validation of the same tree
 * left there, because the newer validation is the one the org still has.
 *
 * Never throws. A record that could not be written costs the next deployment
 * its tests, and that is a warning, not a failed validation.
 *
 * @param {string} tag Tag name
 * @param {object} record The record; `headSha` is the commit the tag annotates
 * @return {Promise<boolean>} True when the tag now carries the record
 */
export async function writeValidationRecord(tag, record) {
  const objectSha = await createTagObject({tag, sha: record.headSha, message: renderRecord(record)});
  if (!objectSha) {
    return false;
  }
  return moveTag(tag, objectSha);
}

/**
 * Reads the record a tag carries.
 *
 * @param {string} tag Tag name
 * @param {{ ref?: typeof fetchTagRef, object?: typeof fetchTagObject }} [api] The two reads, as seams for testing
 * @return {Promise<object|null>} The record, or null when there is no such tag or it does not carry one
 */
export async function readValidationRecord(tag, {ref = fetchTagRef, object = fetchTagObject} = {}) {
  const target = await ref(tag);
  if (!target) {
    return null;
  }
  if (target.type !== 'tag') {
    warn(`${tag} is a lightweight tag, so it carries no validation record; ignoring it.`);
    return null;
  }
  const record = parseRecord((await object(target.sha))?.message);
  if (!record) {
    warn(`${tag} does not carry a readable validation record; ignoring it.`);
  }
  return record;
}

/**
 * Deletes the records the org no longer honours.
 *
 * A validation older than ten days cannot be promoted, so its record is only
 * a tag in the way. Swept from the writer's side, after each new record, so
 * the namespace holds about as many tags as there were validations in the
 * last ten days.
 *
 * Never throws, and never deletes what it cannot date.
 *
 * @param {string} prefix Tag prefix
 * @param {string} environment The environment, or an empty string for none
 * @param {{ now?: number, list?: typeof listTags, object?: typeof fetchTagObject, remove?: typeof deleteTag }} [options] The current time, and the API calls as seams for testing
 * @return {Promise<string[]>} The tags deleted
 */
export async function sweepValidationRecords(prefix, environment, options = {}) {
  const {now = Date.now(), list = listTags, object = fetchTagObject, remove = deleteTag} = options;
  const tags = await list(`${validationNamespace(prefix, environment)}/`);
  const deleted = [];

  for (const entry of tags ?? []) {
    if (entry.type !== 'tag') {
      continue;
    }
    const tagObject = await object(entry.sha);
    if (!tagObject) {
      continue;
    }
    const record = parseRecord(tagObject.message) ?? {validatedAt: tagObject.date};
    const age = ageInDays(record, now);
    if (Number.isFinite(age) && age > VALIDATION_MAX_AGE_DAYS && await remove(entry.tag)) {
      deleted.push(entry.tag);
    }
  }

  if (deleted.length > 0) {
    console.log(`Swept ${deleted.length} expired validation record(s): ${deleted.join(', ')}`);
  }
  return deleted;
}
