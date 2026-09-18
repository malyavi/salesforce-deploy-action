import {writeFile}                             from 'node:fs/promises';
import {run}                                    from './exec.mjs';
import {renderPackageXml, versionOf}            from './manifest.mjs';

/**
 * Dropping deletions the org has already applied.
 *
 * sfdx-git-delta derives `destructiveChanges.xml` from the git diff alone, so
 * it lists every file the branch removed regardless of whether the component is
 * still in the org. Deleting a component that is not there is a hard error —
 * `No <Type> named: X found` — and that error is unavoidable whenever a
 * component left the org by some route other than this pipeline. Removing a
 * custom object, for instance, takes its layouts with it, so a later commit
 * that tidies up the orphaned layout files describes a deletion the org
 * performed months earlier.
 *
 * The check is one `listMetadata` call per type and it only ever *removes*
 * members, so a pruned deployment is a subset of what was going to be
 * attempted anyway.
 *
 * **Fails open.** A type that cannot be listed keeps all of its members: a
 * spurious failure then looks like the unpruned behaviour, whereas guessing the
 * other way would silently skip a deletion that was genuinely required and
 * leave the org ahead of the source with nothing in the log to say so.
 */

/**
 * Metadata types `sf org list metadata` cannot enumerate without also being
 * told a folder. Their members are kept rather than guessed at, because the
 * alternative is dropping a real deletion.
 */
export const FOLDER_SCOPED_TYPES = new Set(['Dashboard', 'Document', 'EmailTemplate', 'Report']);

/**
 * Prunes a destructive manifest against the org and rewrites it on disk.
 *
 * @param {{ path: string, xml: string, types: Array<{ name: string, members: string[] }>, isEmpty: boolean }} destructive Manifest as read from the delta
 * @param {{ orgAlias: string, apiVersion?: string, list?: (typeName: string, orgAlias: string) => Promise<Set<string>|null>, write?: (path: string, xml: string) => Promise<void> }} options The org to check against, and seams for testing
 * @return {Promise<{ manifest: object, dropped: Array<{ type: string, member: string }>, unverified: string[] }>} The manifest to deploy, what was dropped, and the types that could not be checked
 */
export async function pruneDestructive(destructive, options) {
  const {
    orgAlias,
    apiVersion,
    list = existingMembers,
    write = (path, xml) => writeFile(path, xml, 'utf8')
  } = options;

  if (!destructive || destructive.isEmpty) {
    return {manifest: destructive, dropped: [], unverified: []};
  }

  const keptTypes = [];
  const dropped = [];
  const unverified = [];

  for (const type of destructive.types) {
    const existing = await list(type.name, orgAlias);
    if (existing === null) {
      unverified.push(type.name);
      keptTypes.push(type);
      continue;
    }

    const kept = type.members.filter((member) => existing.has(member));
    for (const member of type.members) {
      if (!existing.has(member)) {
        dropped.push({type: type.name, member});
      }
    }
    if (kept.length > 0) {
      keptTypes.push({name: type.name, members: kept});
    }
  }

  if (dropped.length === 0) {
    return {manifest: destructive, dropped, unverified};
  }

  for (const {type, member} of dropped) {
    console.log(`Already absent from the org, not deleting: ${type} ${member}`);
  }

  const version = versionOf(destructive.xml) || apiVersion;
  if (!version) {
    // Only reachable when the delta wrote a manifest with no version element,
    // which sfdx-git-delta does not do — but a rewritten manifest without one
    // is refused by the Metadata API with a less obvious message than this.
    throw new Error(
      'The destructive manifest declares no API version and none was given. ' +
      'Set the `api-version` input, or add `sourceApiVersion` to sfdx-project.json.'
    );
  }

  const xml = renderPackageXml(keptTypes, version);
  await write(destructive.path, xml);

  const componentCount = keptTypes.reduce((total, type) => total + type.members.length, 0);
  console.log(`Pruned ${dropped.length} deletion(s) already applied in the org; ${componentCount} remain.`);

  return {
    manifest: {...destructive, xml, types: keptTypes, componentCount, isEmpty: keptTypes.length === 0},
    dropped,
    unverified
  };
}

/**
 * Full names of one metadata type currently in the org.
 *
 * @param {string} typeName Metadata type to enumerate
 * @param {string} orgAlias Alias of the authenticated org
 * @return {Promise<Set<string>|null>} The full names present, or null when the type cannot be enumerated and its members must be kept
 */
async function existingMembers(typeName, orgAlias) {
  if (FOLDER_SCOPED_TYPES.has(typeName)) {
    console.log(`${typeName} is folder-scoped and cannot be listed without one; keeping its deletions.`);
    return null;
  }

  let output;
  try {
    output = await run(
      'sf',
      ['org', 'list', 'metadata', '--metadata-type', typeName, '--target-org', orgAlias, '--json'],
      {echo: false, capture: true}
    );
  } catch (thrown) {
    console.log(`Could not list ${typeName} in the org; keeping its deletions. ${thrown.message}`);
    return null;
  }

  return parseListing(output, typeName);
}

/**
 * Reads a `sf org list metadata --json` answer.
 *
 * @param {string} output The CLI's stdout
 * @param {string} typeName Metadata type, for the log line
 * @return {Set<string>|null} The full names present, or null when the answer could not be read
 */
export function parseListing(output, typeName) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    console.log(`Could not parse the ${typeName} listing; keeping its deletions.`);
    return null;
  }

  // An org holding none of a type answers with a null or absent result rather
  // than an empty array, and that is a real answer: nothing of this type
  // exists, so every deletion of it is already applied.
  const rows = parsed?.result ?? [];
  if (!Array.isArray(rows)) {
    return new Set();
  }
  return new Set(rows.map((row) => row?.fullName).filter(Boolean));
}

/**
 * Renders the pruning outcome for the job summary.
 *
 * Silent when nothing was pruned: a summary section that says "removed
 * nothing" every run trains a reader to skip the one run where it says
 * otherwise.
 *
 * @param {{ dropped: Array<{ type: string, member: string }>, unverified: string[] }} result Result of `pruneDestructive`
 * @return {string} Markdown, or an empty string when there is nothing to report
 */
export function renderPruned({dropped, unverified}) {
  if (dropped.length === 0 && unverified.length === 0) {
    return '';
  }

  const lines = [];
  if (dropped.length > 0) {
    lines.push(
      `### Deletions skipped — ${dropped.length} already absent from the org`,
      '',
      'These components are gone from the source and were already gone from the org,',
      'so the deployment does not try to delete them again.',
      '',
      '| Metadata type | Component |',
      '| --- | --- |',
      ...dropped.map(({type, member}) => `| \`${type}\` | ${member} |`),
      ''
    );
  }
  if (unverified.length > 0) {
    lines.push(`> Could not check ${unverified.join(', ')} against the org; their deletions were left in place.`, '');
  }
  return lines.join('\n');
}
