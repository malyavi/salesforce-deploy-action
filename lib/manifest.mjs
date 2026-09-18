import {readFile} from 'node:fs/promises';

/**
 * Reading and rendering the manifests sfdx-git-delta writes.
 *
 * Deliberately regex based, in both directions: these documents are machine
 * generated and trivially shaped, and an XML library is a dependency an action
 * would otherwise have to bundle.
 */

/** Members listed per type in a summary before collapsing into a count. */
const MEMBER_PREVIEW_LIMIT = 15;

/**
 * Reads a `package.xml`.
 *
 * @param {string} path File path to the manifest
 * @return {Promise<{ path: string, xml: string, types: Array<{ name: string, members: string[] }>, componentCount: number, isEmpty: boolean }>} Parse result
 */
export async function readManifest(path) {
  let xml;
  try {
    xml = await readFile(path, 'utf8');
  } catch {
    // sfdx-git-delta omits the file entirely when there is nothing of that kind.
    xml = '';
  }
  return {path, ...parseManifest(xml)};
}

/**
 * Parses manifest XML.
 *
 * @param {string} xml The document, or an empty string
 * @return {{ xml: string, types: Array<{ name: string, members: string[] }>, componentCount: number, isEmpty: boolean }} Parse result
 */
export function parseManifest(xml) {
  const types = [];
  for (const [, body] of String(xml ?? '').matchAll(/<types>([\s\S]*?)<\/types>/g)) {
    const name = body.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim();
    if (!name) {
      continue;
    }
    const members = [...body.matchAll(/<members>([\s\S]*?)<\/members>/g)].map((match) => match[1].trim());
    types.push({name, members});
  }
  types.sort((left, right) => left.name.localeCompare(right.name));

  const componentCount = types.reduce((total, type) => total + type.members.length, 0);
  return {xml, types, componentCount, isEmpty: types.length === 0};
}

/**
 * Renders a manifest document from types.
 *
 * @param {Array<{ name: string, members: string[] }>} types Types to include; may be empty
 * @param {string} version API version to declare
 * @return {string} A complete package.xml document
 */
export function renderPackageXml(types, version) {
  const blocks = types.map((type) => {
    const members = type.members.map((member) => `        <members>${member}</members>`);
    return ['    <types>', ...members, `        <name>${type.name}</name>`, '    </types>'].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...blocks,
    `    <version>${version}</version>`,
    '</Package>',
    ''
  ].join('\n');
}

/**
 * The API version a manifest declares.
 *
 * @param {string} xml Manifest contents
 * @return {string|null} The declared version, or null when it declares none
 */
export function versionOf(xml) {
  return xml?.match(/<version>([\s\S]*?)<\/version>/)?.[1]?.trim() || null;
}

/**
 * Splits a manifest into what the change added and what it modified, using the
 * file statuses the API reported.
 *
 * Presentation only: both halves are deployed identically, and the split exists
 * because "3 added, 1 modified" is a sentence a reviewer can check against
 * their own intent while "4 components" is not. A member whose files cannot be
 * matched counts as modified, which is the safer thing to claim.
 *
 * @param {{ types: Array<{ name: string, members: string[] }>, isEmpty: boolean }} manifest Manifest from the delta
 * @param {Array<{ status: string, path: string }>} [changes] Changed files with a git-style status
 * @return {{ added: object, modified: object }} Two manifest-shaped objects
 */
export function splitManifest(manifest, changes = []) {
  const empty = {types: [], componentCount: 0, isEmpty: true};
  if (!manifest || manifest.isEmpty) {
    return {added: empty, modified: {...empty}};
  }

  const addedTypes = [];
  const modifiedTypes = [];

  for (const type of manifest.types) {
    const added = [];
    const modified = [];
    for (const member of type.members) {
      const matching = findMatchingChanges(member, changes);
      if (matching.length > 0 && matching.every((change) => change.status === 'A')) {
        added.push(member);
      } else {
        modified.push(member);
      }
    }
    if (added.length > 0) {
      addedTypes.push({name: type.name, members: added});
    }
    if (modified.length > 0) {
      modifiedTypes.push({name: type.name, members: modified});
    }
  }

  return {added: manifestOf(addedTypes), modified: manifestOf(modifiedTypes)};
}

/**
 * Wraps types in the shape the renderers expect.
 *
 * @param {Array<{ name: string, members: string[] }>} types Types
 * @return {{ types: Array<object>, componentCount: number, isEmpty: boolean }} Manifest-shaped object
 */
function manifestOf(types) {
  return {
    types,
    componentCount: types.reduce((total, type) => total + type.members.length, 0),
    isEmpty: types.length === 0
  };
}

/**
 * Finds the changed files that belong to one manifest member.
 *
 * A member is not a path: `Account.Region__c` is a file under an `Account/`
 * directory, an LWC bundle is a directory, and a class is two files. So the
 * match is by basename, by containing directory, and by prefix — and a member
 * that matches nothing is simply reported as modified.
 *
 * @param {string} member Member name, for example `MyClass` or `Account.MyField__c`
 * @param {Array<{ status: string, path: string }>} changes Changed files
 * @return {Array<{ status: string, path: string }>} Matching changes
 */
function findMatchingChanges(member, changes) {
  const normalized = member.replace(/\\/g, '/');
  const parts = normalized.split('.');
  const last = parts.at(-1);
  const first = parts.length > 1 ? parts[0] : null;

  return changes.filter((change) => {
    const path = decodeURIComponent(change.path).replace(/\\/g, '/');
    const fileName = path.split('/').pop();
    const baseName = fileName.replace(/\.[^.]+(-meta\.xml)?$/, '').replace(/-meta\.xml$/, '');

    if (baseName === normalized || baseName === last) {
      // A field's member name carries its object, and the object is a
      // directory in the path: without this check every object's `Region__c`
      // matches every other object's.
      return first ? path.includes(`/${first}/`) : true;
    }
    if (path.includes(`/${normalized}/`)) {
      return true;
    }
    return fileName.startsWith(`${normalized}.`) || fileName.startsWith(`${normalized}-`);
  });
}

/**
 * Renders a manifest as a markdown table, with the document itself behind a
 * disclosure when there is one.
 *
 * @param {string} heading Heading for the section
 * @param {{ types: Array<{ name: string, members: string[] }>, componentCount: number, xml?: string }} manifest Parsed manifest
 * @return {string} Markdown
 */
export function renderManifest(heading, manifest) {
  const rows = manifest.types.map((type) => {
    const shown = type.members.slice(0, MEMBER_PREVIEW_LIMIT).join(', ');
    const hidden = type.members.length - MEMBER_PREVIEW_LIMIT;
    const members = hidden > 0 ? `${shown}, …and ${hidden} more` : shown;
    return `| \`${type.name}\` | ${type.members.length} | ${members} |`;
  });

  const lines = [
    `### ${heading} — ${manifest.componentCount} component${manifest.componentCount === 1 ? '' : 's'}`,
    '',
    '| Metadata type | Count | Components |',
    '| --- | --: | --- |',
    ...rows,
    ''
  ];

  if (manifest.xml) {
    lines.push('<details><summary>Generated manifest</summary>', '', '```xml', manifest.xml.trim(), '```', '', '</details>', '');
  }
  return lines.join('\n');
}

/**
 * Renders the whole scope of a run: what was added, modified and deleted, plus
 * the directories validated whole rather than as a delta.
 *
 * @param {object} delta The delta description
 * @param {{ label?: string, environment?: string, extraDirs?: string[] }} [options] How to name the target in the heading
 * @return {string} Markdown
 */
export function renderDeltaSummary(delta, options = {}) {
  const target = options.environment ? ` (${options.environment})` : '';
  const sections = [`## Delta against \`${short(delta.baseSha)}\`${target}`, ''];

  if (delta.added && !delta.added.isEmpty) {
    sections.push(renderManifest('Added', delta.added));
  }
  if (delta.modified && !delta.modified.isEmpty) {
    sections.push(renderManifest('Modified', delta.modified));
  }
  if (!delta.added && !delta.modified && delta.package && !delta.package.isEmpty) {
    sections.push(renderManifest('Added and modified', delta.package));
  }
  if (delta.destructive && !delta.destructive.isEmpty) {
    sections.push(renderManifest('Deleted', delta.destructive));
  }
  if (delta.extraChanged) {
    sections.push(renderExtraDirs(delta.extraFiles ?? [], options.extraDirs ?? []));
  }
  return sections.join('\n');
}

/**
 * Renders the extra directories' contribution to the scope.
 *
 * Listed as file paths rather than as a manifest table because there is no
 * manifest to show: these directories are validated whole, so the changed
 * files explain *why* they are in scope while the validation covers all of
 * them either way.
 *
 * @param {string[]} files Changed paths under the extra directories
 * @param {string[]} dirs The extra directories themselves
 * @return {string} Markdown
 */
function renderExtraDirs(files, dirs) {
  return [
    `### Validated whole (${dirs.map((dir) => `\`${dir}/\``).join(', ')})`,
    '',
    'These directories are outside the delta, so they never appear in a manifest;',
    'every component in them is part of this check-only run. **Nothing here is deployed** —',
    'validating a directory is not a promise to deploy it.',
    '',
    ...files.map((file) => `- \`${file}\``),
    ''
  ].join('\n');
}

/**
 * A commit as a reader refers to it.
 *
 * @param {string} sha Commit SHA, or anything else
 * @return {string} The first seven characters of a SHA, or the value unchanged
 */
function short(sha) {
  return /^[0-9a-f]{40}$/i.test(sha ?? '') ? sha.slice(0, 7) : String(sha ?? '');
}
