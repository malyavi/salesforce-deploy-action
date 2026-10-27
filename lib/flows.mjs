import {access, mkdir, writeFile}                  from 'node:fs/promises';
import {dirname, posix}                            from 'node:path';
import {run}                                       from './exec.mjs';
import {parseManifest, renderPackageXml, versionOf} from './manifest.mjs';

/**
 * Deleting flows the way the org will accept.
 *
 * sfdx-git-delta lists a deleted flow by its bare name, and the org refuses
 * that deletion — "insufficient access rights on cross-reference id" — on two
 * counts:
 *
 *  - **An active flow cannot be deleted.** Deploying a version as `Obsolete`
 *    or `Draft` does not help: it adds an inactive version and leaves the
 *    active one running. A `FlowDefinition` with `activeVersionNumber` 0 does
 *    help, and it takes effect inside the deployment that carries it, check-only
 *    or not, so the tests of whatever replaces the flow run without it.
 *  - **A flow is deleted version by version.** Since API 44 a flow's versions
 *    are separate components, and the bare name deletes none of them.
 *
 * So, for every deleted flow the org still has, the deletion is rewritten to
 * name each of its versions, and an active one also gets a `FlowDefinition`
 * deactivating it in the package. The deletions are post-destructive, so they
 * run after the deactivation, in the same transaction: a failure anywhere rolls
 * all of it back and leaves the flow as it was.
 *
 * Both actions rewrite the package the same way from the same two trees, so a
 * validation is still the package the deployment would send, and can be
 * promoted.
 *
 * **Fails open.** A flow whose versions cannot be read keeps its deletion as
 * sfdx-git-delta wrote it, and the org answers exactly as it would have.
 */

/** A flow's API name, which is all a query is ever handed. */
const FLOW_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The flows a destructive manifest deletes outright.
 *
 * A member with a version suffix — `My_Flow-3` — already names a version and
 * is left alone.
 *
 * @param {{ types: Array<{ name: string, members: string[] }> }|undefined} destructive Destructive manifest
 * @return {string[]} The flows' API names
 */
export function flowDeletions(destructive) {
  const type = destructive?.types?.find((entry) => entry.name === 'Flow');
  return (type?.members ?? []).filter((member) => FLOW_NAME.test(member));
}

/**
 * Rewrites the deletions of whole flows into deletions the org will accept.
 *
 * Rewrites both manifests on disk, and writes each `FlowDefinition` next to
 * where the flow's file used to be, so `--manifest` and a converted package
 * both find it. A `FlowDefinition` the change already carries is left as it is.
 *
 * @param {object} delta The delta description; its `package` and `destructive` are replaced
 * @param {{ orgAlias: string, sourceDirs: string[], apiVersion?: string }} config Resolved configuration
 * @param {{ versions?: typeof flowVersions, source?: typeof flowPathAt, exists?: (path: string) => Promise<boolean>, write?: (path: string, text: string) => Promise<void> }} [seams] The org, git and disk, for testing
 * @return {Promise<{ flows: Array<{ name: string, versions: number[], deactivated: boolean }>, unverified: boolean }>} What was rewritten, and whether the org could not be asked
 */
export async function stageFlowDeletions(delta, config, seams = {}) {
  const {versions = flowVersions, source = flowPathAt, exists = fileExists, write = writeText} = seams;

  const names = flowDeletions(delta.destructive);
  if (names.length === 0) {
    return {flows: [], unverified: false};
  }

  const found = await versions(names, config.orgAlias);
  if (!found) {
    return {flows: [], unverified: true};
  }
  const present = names.filter((name) => found.get(name)?.versions.length > 0);
  if (present.length === 0) {
    return {flows: [], unverified: false};
  }

  const version = versionOf(delta.package?.xml) || versionOf(delta.destructive.xml) || config.apiVersion;
  const flows = [];
  const definitions = [];
  for (const name of present) {
    const {versions: numbers, active} = found.get(name);
    let deactivated = false;
    if (active) {
      const path = definitionPath(await source(delta.baseSha, name, config.sourceDirs), name, config.sourceDirs);
      if (!await exists(path)) {
        await write(path, renderDefinition());
      }
      definitions.push(name);
      deactivated = true;
    }
    flows.push({name, versions: numbers, deactivated});
    console.log(
      `Deleting Flow ${name} as ${numbers.length} version(s)` +
      (deactivated ? `, deactivating version ${active} first.` : '.')
    );
  }

  delta.destructive = await rewrite(delta.destructive, withVersions(delta.destructive.types, flows), version, write);
  if (definitions.length > 0) {
    delta.package = await rewrite(delta.package, withDefinitions(delta.package?.types ?? [], definitions), version, write);
  }
  return {flows, unverified: false};
}

/**
 * Looks up the versions of flows in the org, and which one is active.
 *
 * @param {string[]} names The flows' API names
 * @param {string} orgAlias Alias of the authenticated org
 * @return {Promise<Map<string, { versions: number[], active: number|null }>|null>} Each flow the org has, or null when it could not be asked
 */
export async function flowVersions(names, orgAlias) {
  const list = names.map((name) => `'${name}'`).join(', ');
  const query = 'SELECT VersionNumber, Status, Definition.DeveloperName FROM Flow ' +
    `WHERE Definition.NamespacePrefix = null AND Definition.DeveloperName IN (${list})`;

  let output;
  try {
    output = await run(
      'sf',
      ['data', 'query', '--use-tooling-api', '--query', query, '--target-org', orgAlias, '--json'],
      {echo: false, capture: true}
    );
  } catch (thrown) {
    console.log(`Could not look up the deleted flows in the org; keeping their deletions. ${thrown.message}`);
    return null;
  }
  return parseVersions(output);
}

/**
 * Reads a `sf data query --json` answer about flow versions.
 *
 * @param {string} output The CLI's stdout
 * @return {Map<string, { versions: number[], active: number|null }>|null} Each flow the org has, or null when the answer could not be read
 */
export function parseVersions(output) {
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

  const flows = new Map();
  for (const row of rows) {
    const name = row?.Definition?.DeveloperName;
    if (!name || !Number.isInteger(row.VersionNumber)) {
      continue;
    }
    const flow = flows.get(name) ?? {versions: [], active: null};
    flow.versions.push(row.VersionNumber);
    if (row.Status === 'Active') {
      flow.active = row.VersionNumber;
    }
    flows.set(name, flow);
  }
  for (const flow of flows.values()) {
    flow.versions.sort((left, right) => left - right);
  }
  return flows;
}

/**
 * Finds a flow's file in a commit.
 *
 * @param {string} sha The commit
 * @param {string} name The flow's API name
 * @param {string[]} sourceDirs Directories to look in
 * @return {Promise<string|null>} The file's path, or null when the commit has no such flow
 */
export async function flowPathAt(sha, name, sourceDirs) {
  let listing;
  try {
    listing = await run('git', ['ls-tree', '-r', '--name-only', sha, '--', ...sourceDirs], {echo: false, capture: true});
  } catch {
    return null;
  }
  return listing.split('\n').map((line) => line.trim()).find((line) => line.endsWith(`/flows/${name}.flow-meta.xml`)) ?? null;
}

/**
 * Where a flow's `FlowDefinition` goes: beside the `flows` directory its file
 * was in, or under the first source directory when that is not known.
 *
 * @param {string|null} flowPath The flow's file, as the base commit had it
 * @param {string} name The flow's API name
 * @param {string[]} sourceDirs Directories the delta covers
 * @return {string} The path to write
 */
export function definitionPath(flowPath, name, sourceDirs) {
  // Git's separators, whatever the runner's: the path comes from `git ls-tree`.
  const flowsDir = flowPath ? posix.dirname(flowPath) : posix.join(sourceDirs[0], 'main', 'default', 'flows');
  return posix.join(posix.dirname(flowsDir), 'flowDefinitions', `${name}.flowDefinition-meta.xml`);
}

/**
 * A `FlowDefinition` that leaves its flow with no active version.
 *
 * @return {string} The document
 */
export function renderDefinition() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<FlowDefinition xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <activeVersionNumber>0</activeVersionNumber>',
    '</FlowDefinition>',
    ''
  ].join('\n');
}

/**
 * Renders how the flow deletions were rewritten, for the job summary.
 *
 * Silent when no flow was involved.
 *
 * @param {{ flows: Array<{ name: string, versions: number[], deactivated: boolean }>, unverified: boolean }} staged Result of `stageFlowDeletions`
 * @return {string} Markdown, or an empty string when there is nothing to report
 */
export function renderFlowDeletions({flows, unverified}) {
  if (unverified) {
    return '> Could not look up the deleted flows in the org; their deletions were left as they were.\n';
  }
  if (flows.length === 0) {
    return '';
  }

  return [
    `### Flow deletions — ${flows.length} rewritten`,
    '',
    'The org deletes a flow version by version, and refuses to delete an active one, so each',
    'deletion names every version, and an active flow is deactivated first by a `FlowDefinition`',
    'in the same deployment.',
    '',
    '| Flow | Versions deleted | Deactivated first |',
    '| --- | --- | --- |',
    ...flows.map(({name, versions, deactivated}) => `| ${name} | ${versions.join(', ')} | ${deactivated ? 'yes' : 'no'} |`),
    ''
  ].join('\n');
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
 * Types with each named flow replaced by its versions.
 *
 * @param {Array<{ name: string, members: string[] }>} types Manifest types
 * @param {Array<{ name: string, versions: number[] }>} flows The flows and their versions
 * @return {Array<{ name: string, members: string[] }>} The types, with the versions in
 */
function withVersions(types, flows) {
  const byName = new Map(flows.map(({name, versions}) => [name, versions.map((number) => `${name}-${number}`)]));
  return types.map((type) => type.name === 'Flow'
    ? {...type, members: [...new Set(type.members.flatMap((member) => byName.get(member) ?? [member]))]}
    : type);
}

/**
 * Types with some `FlowDefinition`s added.
 *
 * @param {Array<{ name: string, members: string[] }>} types Manifest types
 * @param {string[]} names The flows whose definitions to add
 * @return {Array<{ name: string, members: string[] }>} The types, with the definitions in
 */
function withDefinitions(types, names) {
  const others = types.filter((type) => type.name !== 'FlowDefinition');
  const existing = types.find((type) => type.name === 'FlowDefinition')?.members ?? [];
  const members = [...new Set([...existing, ...names])].sort();
  return [...others, {name: 'FlowDefinition', members}].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Whether a file exists.
 *
 * @param {string} path File path
 * @return {Promise<boolean>} True when it does
 */
async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
