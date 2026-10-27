import {mkdir, writeFile}                          from 'node:fs/promises';
import {dirname, join}                             from 'node:path';
import {mask}                                      from './core.mjs';
import {run}                                       from './exec.mjs';
import {parseManifest, renderPackageXml, versionOf} from './manifest.mjs';

/**
 * Retiring a flow that is still active in the org.
 *
 * Deleting a flow's file puts the flow in `destructiveChanges.xml`, and the org
 * refuses to delete a flow with an active version — "insufficient access rights
 * on cross-reference id". Nothing in a metadata package can deactivate one
 * either: deploying a version as `Obsolete` or `Draft` adds an inactive version
 * and leaves the active one running, and `FlowDefinition`, which could, only
 * exists up to API 43.
 *
 * The active flow also keeps firing for as long as it is active, so a change
 * that replaces a record-triggered flow with something else — a trigger, a new
 * flow — fails its own tests against the old one before the deletion is even
 * attempted.
 *
 * So a deletion of an active flow is split in two:
 *
 *  1. **In the package.** The deletion is taken out of the destructive
 *     manifest, and for a record-triggered flow an *inert* active version goes
 *     in instead: the version the org last received, with its entry conditions
 *     replaced by two that contradict each other. It deploys in the same
 *     transaction as everything else, so the old behaviour stops at the moment
 *     its replacement starts, and the tests run without it.
 *  2. **After the deployment.** The deploy action deactivates the flow through
 *     the Tooling API and deletes it with a deployment of its own. A check-only
 *     run cannot do this half; it reports what the deployment will do.
 *
 * Both actions build the same package from the same two trees, so a validation
 * that took step 1 is still the package the deployment would send, and can be
 * promoted.
 *
 * **Fails open.** A flow whose state cannot be read keeps its deletion, and the
 * org answers exactly as it would have without any of this.
 */

/** Trigger types whose entry conditions live in `<start>` as `<filters>`. */
export const RECORD_TRIGGER_TYPES = new Set(['RecordBeforeSave', 'RecordAfterSave', 'RecordBeforeDelete']);

/** A flow's API name, which is all a Tooling query is ever handed. */
const FLOW_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Where the deletion deployment's manifests are written. */
const RETIRED_DIR = '.retired-flows';

/**
 * Entry conditions no record can meet: `Id` both is and is not null. Holds in
 * a before-save insert, where `Id` is null, as much as anywhere else.
 */
const NEVER = [
  ['filterLogic', 'and'],
  ['filters', 'true'],
  ['filters', 'false']
];

/**
 * The flows a destructive manifest deletes outright.
 *
 * A member with a version suffix — `My_Flow-3` — deletes one inactive version
 * and is left alone; only a whole flow can be the active one.
 *
 * @param {{ types: Array<{ name: string, members: string[] }> }|undefined} destructive Destructive manifest
 * @return {string[]} The flows' API names
 */
export function flowDeletions(destructive) {
  const type = destructive?.types?.find((entry) => entry.name === 'Flow');
  return (type?.members ?? []).filter((member) => FLOW_NAME.test(member));
}

/**
 * Takes active flows out of the deletions, and puts an inert active version of
 * each record-triggered one in the package.
 *
 * Rewrites both manifests on disk, and writes each inert version where the
 * flow's file used to be, so `--manifest` and a converted package both find it.
 *
 * @param {object} delta The delta description; its `package` and `destructive` are replaced
 * @param {{ orgAlias: string, sourceDirs: string[], apiVersion?: string }} config Resolved configuration
 * @param {{ definitions?: typeof flowDefinitions, source?: typeof flowSourceAt, write?: (path: string, text: string) => Promise<void> }} [seams] The org, git and disk, for testing
 * @return {Promise<{ retiring: Array<{ name: string, inert: boolean }>, unverified: boolean }>} The flows the deployment has to finish retiring, and whether the org could not be asked
 */
export async function stageRetiringFlows(delta, config, seams = {}) {
  const {definitions = flowDefinitions, source = flowSourceAt, write = writeText} = seams;

  const names = flowDeletions(delta.destructive);
  if (names.length === 0) {
    return {retiring: [], unverified: false};
  }

  const found = await definitions(names, config.orgAlias);
  if (!found) {
    return {retiring: [], unverified: true};
  }
  const active = names.filter((name) => found.get(name)?.activeVersion);
  if (active.length === 0) {
    return {retiring: [], unverified: false};
  }

  const version = versionOf(delta.package?.xml) || versionOf(delta.destructive.xml) || config.apiVersion;
  const retiring = [];
  const inert = [];
  for (const name of active) {
    const file = await source(delta.baseSha, name, config.sourceDirs);
    const xml = file ? inertFlow(file.xml) : null;
    if (xml) {
      await write(file.path, xml);
      inert.push(name);
    }
    retiring.push({name, inert: Boolean(xml)});
    console.log(xml
      ? `Active in the org, so deploying an inert version and deleting it afterwards: Flow ${name}`
      : `Active in the org, so deleting it after the deployment: Flow ${name}`);
  }

  delta.destructive = await rewrite(delta.destructive, without(delta.destructive.types, active), version, write);
  if (inert.length > 0) {
    delta.package = await rewrite(delta.package, withFlows(delta.package?.types ?? [], inert), version, write);
  }
  return {retiring, unverified: false};
}

/**
 * Deactivates flows and deletes them, in a deployment of their own.
 *
 * Looks the flows up again rather than trusting the validation's view of them:
 * a flow somebody deactivated or deleted by hand in the meantime is simply
 * skipped.
 *
 * @param {string[]} names The flows' API names
 * @param {{ orgAlias: string, apiVersion: string, waitMinutes: number }} config Resolved configuration
 * @param {{ definitions?: typeof flowDefinitions, deactivate?: typeof deactivateFlow, remove?: (names: string[], config: object) => Promise<void> }} [seams] The org, for testing
 * @return {Promise<{ deactivated: string[], deleted: string[] }>} What was done
 * @throws {Error} When the org cannot be asked, or refuses either step
 */
export async function retireFlows(names, config, seams = {}) {
  const {definitions = flowDefinitions, deactivate = deactivateFlow, remove = deleteFlows} = seams;

  if (names.length === 0) {
    return {deactivated: [], deleted: []};
  }
  const found = await definitions(names, config.orgAlias);
  if (!found) {
    throw new Error(`Could not look up ${names.join(', ')} in the org, so they were neither deactivated nor deleted.`);
  }

  const present = names.filter((name) => found.has(name));
  const deactivated = [];
  for (const name of present) {
    const definition = found.get(name);
    if (definition.activeVersion) {
      await deactivate(definition.id, config);
      console.log(`Deactivated Flow ${name} (version ${definition.activeVersion} was active).`);
      deactivated.push(name);
    }
  }

  if (present.length > 0) {
    await remove(present, config);
  }
  return {deactivated, deleted: present};
}

/**
 * Makes a record-triggered flow inert and active.
 *
 * Only `<start>` and `<status>` change. Every element stays, so the version
 * saves exactly as the one the org already holds did; it just never starts.
 *
 * @param {string} xml The flow's metadata
 * @return {string|null} The inert version, or null when this flow is not one that can be made inert this way
 */
export function inertFlow(xml) {
  const starts = [...String(xml ?? '').matchAll(/<start>([\s\S]*?)<\/start>/g)];
  const statuses = String(xml ?? '').match(/<status>[^<]*<\/status>/g) ?? [];
  if (starts.length !== 1 || statuses.length !== 1) {
    return null;
  }

  const [whole, body] = starts[0];
  const triggerType = body.match(/<triggerType>([^<]*)<\/triggerType>/)?.[1]?.trim();
  // The conditions go before `<object>`: after the inherited position fields,
  // the element's own fields are in alphabetical order, and the filter fields
  // are the last before it.
  const anchor = body.match(/\n([ \t]*)<object>/);
  if (!RECORD_TRIGGER_TYPES.has(triggerType) || !anchor) {
    return null;
  }

  const indent = anchor[1];
  const stripped = body
    .replace(/\n[ \t]*<filters>[\s\S]*?<\/filters>/g, '')
    .replace(/\n[ \t]*<(filterLogic|filterFormula|doesRequireRecordChangedToMeetCriteria)>[\s\S]*?<\/\1>/g, '');
  const never = NEVER.map(([element, value]) => renderCondition(element, value, indent)).join('');
  const start = `<start>${stripped.replace(/\n[ \t]*<object>/, `${never}\n${indent}<object>`)}</start>`;

  return xml.replace(whole, start).replace(statuses[0], '<status>Active</status>');
}

/**
 * Finds a flow's file in a commit.
 *
 * @param {string} sha The commit
 * @param {string} name The flow's API name
 * @param {string[]} sourceDirs Directories to look in
 * @return {Promise<{ path: string, xml: string }|null>} The file, or null when the commit has no such flow
 */
export async function flowSourceAt(sha, name, sourceDirs) {
  let listing;
  try {
    listing = await run('git', ['ls-tree', '-r', '--name-only', sha, '--', ...sourceDirs], {echo: false, capture: true});
  } catch {
    return null;
  }

  const path = listing.split('\n').map((line) => line.trim()).find((line) => line.endsWith(`/flows/${name}.flow-meta.xml`));
  if (!path) {
    return null;
  }
  try {
    return {path, xml: await run('git', ['show', `${sha}:./${path}`], {echo: false, capture: true})};
  } catch {
    return null;
  }
}

/**
 * Looks flows up in the org.
 *
 * @param {string[]} names The flows' API names
 * @param {string} orgAlias Alias of the authenticated org
 * @return {Promise<Map<string, { id: string, activeVersion: number|null }>|null>} Each flow the org has, or null when it could not be asked
 */
export async function flowDefinitions(names, orgAlias) {
  const list = names.map((name) => `'${name}'`).join(', ');
  const query = 'SELECT Id, DeveloperName, ActiveVersion.VersionNumber FROM FlowDefinition ' +
    `WHERE NamespacePrefix = null AND DeveloperName IN (${list})`;

  let output;
  try {
    output = await run(
      'sf',
      ['data', 'query', '--use-tooling-api', '--query', query, '--target-org', orgAlias, '--json'],
      {echo: false, capture: true}
    );
  } catch (thrown) {
    console.log(`Could not look up the flows in the org; keeping their deletions. ${thrown.message}`);
    return null;
  }
  return parseDefinitions(output);
}

/**
 * Reads a `sf data query --json` answer about flow definitions.
 *
 * @param {string} output The CLI's stdout
 * @return {Map<string, { id: string, activeVersion: number|null }>|null} Each flow the org has, or null when the answer could not be read
 */
export function parseDefinitions(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    console.log('Could not parse the flow lookup; keeping the deletions.');
    return null;
  }

  const rows = parsed?.result?.records;
  if (!Array.isArray(rows)) {
    return null;
  }
  return new Map(rows.map((row) => [
    row.DeveloperName,
    {id: row.Id, activeVersion: row.ActiveVersion?.VersionNumber ?? null}
  ]));
}

/**
 * Renders what happened to the flows being retired, for the job summary.
 *
 * Silent when no flow was involved.
 *
 * @param {{ retiring: Array<{ name: string, inert: boolean }>, unverified: boolean }} staged Result of `stageRetiringFlows`
 * @param {{ checkOnly: boolean }} options Whether this run can finish the job
 * @return {string} Markdown, or an empty string when there is nothing to report
 */
export function renderRetiring({retiring, unverified}, {checkOnly}) {
  if (unverified) {
    return '> Could not look up the deleted flows in the org; their deletions were left in place.\n';
  }
  if (retiring.length === 0) {
    return '';
  }

  const after = checkOnly
    ? 'The deploy action deactivates and deletes them once this change is deployed.'
    : 'They are deactivated and deleted once the deployment succeeds.';
  return [
    `### Flows retired — ${retiring.length} still active in the org`,
    '',
    'The org will not delete an active flow, so these deletions are not in this package.',
    after,
    '',
    '| Flow | In this package |',
    '| --- | --- |',
    ...retiring.map(({name, inert}) => `| ${name} | ${inert ? 'an inert active version, which never starts' : 'nothing'} |`),
    ''
  ].join('\n');
}

/**
 * Renders how retiring the flows ended, for the job summary.
 *
 * @param {string[]} names The flows the deployment left to retire
 * @param {{ result?: { deactivated: string[], deleted: string[] }, failure?: string }} outcome What was done, or why it was not
 * @return {string} Markdown
 */
export function renderRetired(names, {result, failure}) {
  if (failure) {
    return [
      `### Flows not retired — ${names.join(', ')}`,
      '',
      'The deployment succeeded, but these flows could not be deactivated and deleted afterwards.',
      'The anchor was left where it was, so the next deployment of this branch retries them.',
      '',
      '```',
      failure.trim(),
      '```',
      ''
    ].join('\n');
  }

  const skipped = names.filter((name) => !result.deleted.includes(name));
  return [
    `### Flows retired — ${result.deleted.length} deleted`,
    '',
    '| Flow | Done |',
    '| --- | --- |',
    ...result.deleted.map((name) => `| ${name} | ${result.deactivated.includes(name) ? 'deactivated, then deleted' : 'deleted'} |`),
    ...skipped.map((name) => `| ${name} | already gone from the org |`),
    ''
  ].join('\n');
}

/**
 * Deactivates a flow by setting its definition's active version to none.
 *
 * Through the REST API rather than the CLI: `Metadata` is a compound field,
 * which `sf data update record` cannot set.
 *
 * @param {string} definitionId The flow definition's id
 * @param {{ orgAlias: string, apiVersion: string }} config Resolved configuration
 * @return {Promise<void>}
 * @throws {Error} When the org refuses
 */
export async function deactivateFlow(definitionId, {orgAlias, apiVersion}) {
  const org = JSON.parse(await run(
    'sf',
    ['org', 'display', '--target-org', orgAlias, '--json'],
    {echo: false, capture: true}
  ))?.result;
  mask(org?.accessToken);

  const url = `${org?.instanceUrl}/services/data/v${apiVersion}/tooling/sobjects/FlowDefinition/${definitionId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {'Authorization': `Bearer ${org?.accessToken}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({Metadata: {activeVersionNumber: 0}})
  });
  if (!response.ok) {
    throw new Error(`The org would not deactivate flow definition ${definitionId}: ${response.status} ${await response.text()}`);
  }
}

/**
 * Deletes flows in a deployment of nothing else.
 *
 * Runs no tests: the package holds no Apex, and the org accepts that even in
 * production.
 *
 * @param {string[]} names The flows' API names
 * @param {{ orgAlias: string, apiVersion: string, waitMinutes: number }} config Resolved configuration
 * @return {Promise<void>}
 */
async function deleteFlows(names, {orgAlias, apiVersion, waitMinutes}) {
  const manifest = join(RETIRED_DIR, 'package.xml');
  const destructive = join(RETIRED_DIR, 'destructiveChanges.xml');
  await writeText(manifest, renderPackageXml([], apiVersion));
  await writeText(destructive, renderPackageXml([{name: 'Flow', members: names}], apiVersion));

  await run('sf', [
    'project', 'deploy', 'start',
    '--target-org', orgAlias,
    '--manifest', manifest,
    '--post-destructive-changes', destructive,
    '--test-level', 'NoTestRun',
    '--wait', String(waitMinutes)
  ]);
}

/**
 * Rewrites a manifest with new types, keeping its path.
 *
 * @param {{ path: string }} manifest The manifest to replace
 * @param {Array<{ name: string, members: string[] }>} types What it lists now
 * @param {string} version API version to declare
 * @param {(path: string, text: string) => Promise<void>} write Writes the file
 * @return {Promise<object>} The manifest as now written
 */
async function rewrite(manifest, types, version, write) {
  const xml = renderPackageXml(types, version);
  await write(manifest.path, xml);
  return {...manifest, ...parseManifest(xml)};
}

/**
 * Types with some flows taken out.
 *
 * @param {Array<{ name: string, members: string[] }>} types Manifest types
 * @param {string[]} names The flows to drop
 * @return {Array<{ name: string, members: string[] }>} The types left
 */
function without(types, names) {
  return types
    .map((type) => type.name === 'Flow' ? {...type, members: type.members.filter((member) => !names.includes(member))} : type)
    .filter((type) => type.members.length > 0);
}

/**
 * Types with some flows added.
 *
 * @param {Array<{ name: string, members: string[] }>} types Manifest types
 * @param {string[]} names The flows to add
 * @return {Array<{ name: string, members: string[] }>} The types, with the flows in
 */
function withFlows(types, names) {
  const others = types.filter((type) => type.name !== 'Flow');
  const flows = types.find((type) => type.name === 'Flow')?.members ?? [];
  const members = [...new Set([...flows, ...names])].sort();
  return [...others, {name: 'Flow', members}].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * One entry condition, at the indentation of the element it goes before.
 *
 * @param {string} element `filterLogic` or `filters`
 * @param {string} value The logic, or whether `Id` is null
 * @param {string} indent Indentation of `<start>`'s children
 * @return {string} XML, starting with a newline
 */
function renderCondition(element, value, indent) {
  if (element === 'filterLogic') {
    return `\n${indent}<filterLogic>${value}</filterLogic>`;
  }
  const step = indent.includes('\t') ? '\t' : '    ';
  return [
    '',
    `${indent}<filters>`,
    `${indent}${step}<field>Id</field>`,
    `${indent}${step}<operator>IsNull</operator>`,
    `${indent}${step}<value>`,
    `${indent}${step}${step}<booleanValue>${value}</booleanValue>`,
    `${indent}${step}</value>`,
    `${indent}</filters>`
  ].join('\n');
}

/**
 * Writes a file, creating its directory.
 *
 * @param {string} path File path
 * @param {string} text Contents
 * @return {Promise<void>}
 */
async function writeText(path, text) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, text, 'utf8');
}
