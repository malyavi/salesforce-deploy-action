import {describe, it}                                    from 'node:test';
import assert                                             from 'node:assert/strict';
import {parseManifest}                                    from '../lib/manifest.mjs';
import {FOLDER_SCOPED_TYPES, parseListing, pruneDestructive, renderPruned} from '../lib/destructive.mjs';

/**
 * Pruning deletions the org has already applied.
 *
 * The direction of the failure is the thing to hold onto: dropping a member
 * that is still in the org would leave the org ahead of the source silently,
 * so every uncertainty keeps the member and lets the deployment speak.
 */

const manifestOf = (xml) => ({path: '.delta/destructiveChanges/destructiveChanges.xml', ...parseManifest(xml)});

const DESTRUCTIVE = manifestOf(`<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>OldClass</members>
        <members>GoneClass</members>
        <name>ApexClass</name>
    </types>
    <types>
        <members>Account-Old Layout</members>
        <name>Layout</name>
    </types>
    <version>67.0</version>
</Package>
`);

/**
 * A pruning run with the org and the disk both stubbed.
 *
 * @param {object} manifest Destructive manifest to prune
 * @param {Record<string, string[]|null>} org What each type answers, or null for a type that cannot be listed
 * @return {Promise<{ result: object, written: Array<{ path: string, xml: string }> }>} The outcome and whatever was written
 */
async function prune(manifest, org) {
  const written = [];
  const result = await pruneDestructive(manifest, {
    orgAlias: 'target',
    list: async (typeName) => (org[typeName] === null || org[typeName] === undefined
      ? null
      : new Set(org[typeName])),
    write: async (path, xml) => {
      written.push({path, xml});
    }
  });
  return {result, written};
}

describe('pruneDestructive', () => {
  it('drops a member the org no longer holds and keeps the rest', async () => {
    const {result, written} = await prune(DESTRUCTIVE, {
      ApexClass: ['OldClass'],
      Layout: ['Account-Old Layout']
    });

    assert.deepEqual(result.dropped, [{type: 'ApexClass', member: 'GoneClass'}]);
    assert.equal(result.manifest.componentCount, 2);
    assert.deepEqual(
      result.manifest.types.find((type) => type.name === 'ApexClass').members,
      ['OldClass']
    );
    assert.equal(written.length, 1, 'The manifest is rewritten on disk, since that is what the CLI reads.');
    assert.equal(parseManifest(written[0].xml).componentCount, 2);
  });

  it('keeps the version the delta declared in the rewritten manifest', async () => {
    const {written} = await prune(DESTRUCTIVE, {ApexClass: [], Layout: []});
    assert.match(written[0].xml, /<version>67\.0<\/version>/);
  });

  it('writes nothing when every member survives', async () => {
    const {result, written} = await prune(DESTRUCTIVE, {
      ApexClass: ['OldClass', 'GoneClass'],
      Layout: ['Account-Old Layout']
    });
    assert.deepEqual(result.dropped, []);
    assert.deepEqual(written, []);
  });

  it('becomes empty when the org holds none of it', async () => {
    const {result} = await prune(DESTRUCTIVE, {ApexClass: [], Layout: []});
    assert.equal(result.manifest.isEmpty, true);
    assert.equal(result.dropped.length, 3);
  });

  it('keeps every member of a type it could not list, and says which', async () => {
    // Fails open: a spurious listing failure then behaves like no pruning at
    // all, where guessing the other way would skip a real deletion.
    const {result} = await prune(DESTRUCTIVE, {ApexClass: null, Layout: ['Account-Old Layout']});
    assert.deepEqual(result.unverified, ['ApexClass']);
    assert.deepEqual(result.dropped, []);
    assert.equal(result.manifest.componentCount, 3);
  });

  it('passes an empty manifest straight through', async () => {
    const empty = manifestOf('');
    const {result, written} = await prune(empty, {});
    assert.equal(result.manifest, empty);
    assert.deepEqual(written, []);
  });

  it('refuses to rewrite a manifest with no version and no fallback', async () => {
    const versionless = manifestOf('<types><members>X</members><name>ApexClass</name></types>');
    await assert.rejects(
      () => pruneDestructive(versionless, {orgAlias: 'target', list: async () => new Set(), write: async () => {}}),
      /declares no API version/
    );
  });

  it('uses the api-version fallback when the manifest carries none', async () => {
    const versionless = manifestOf('<types><members>X</members><name>ApexClass</name></types>');
    const written = [];
    await pruneDestructive(versionless, {
      orgAlias: 'target',
      apiVersion: '62.0',
      list: async () => new Set(),
      write: async (path, xml) => written.push(xml)
    });
    assert.match(written[0], /<version>62\.0<\/version>/);
  });
});

describe('FOLDER_SCOPED_TYPES', () => {
  it('holds the types that cannot be listed without a folder', () => {
    // `sf org list metadata` refuses these without `--folder`, so their
    // members are kept rather than guessed at.
    for (const type of ['Dashboard', 'Document', 'EmailTemplate', 'Report']) {
      assert.ok(FOLDER_SCOPED_TYPES.has(type), type);
    }
  });
});

describe('parseListing', () => {
  it('reads the full names out of the CLI answer', () => {
    const listing = parseListing('{"status":0,"result":[{"fullName":"A"},{"fullName":"B"}]}', 'ApexClass');
    assert.deepEqual([...listing], ['A', 'B']);
  });

  it('reads an org holding none of a type as an empty set, not as a failure', () => {
    // That is a real answer: nothing of this type exists, so every deletion of
    // it is already applied.
    assert.deepEqual([...parseListing('{"status":0,"result":null}', 'ApexClass')], []);
    assert.deepEqual([...parseListing('{"status":0}', 'ApexClass')], []);
  });

  it('answers null for output that is not JSON, so the members are kept', () => {
    assert.equal(parseListing('Warning: update available\n', 'ApexClass'), null);
  });

  it('skips a row with no full name rather than adding undefined to the set', () => {
    assert.deepEqual([...parseListing('{"result":[{"fullName":"A"},{}]}', 'ApexClass')], ['A']);
  });
});

describe('renderPruned', () => {
  it('says nothing when nothing was pruned', () => {
    // A section that says "removed nothing" every run trains a reader to skip
    // the one run where it says otherwise.
    assert.equal(renderPruned({dropped: [], unverified: []}), '');
  });

  it('tables what it dropped', () => {
    const markdown = renderPruned({dropped: [{type: 'ApexClass', member: 'GoneClass'}], unverified: []});
    assert.match(markdown, /### Deletions skipped — 1 already absent from the org/);
    assert.match(markdown, /\| `ApexClass` \| GoneClass \|/);
  });

  it('notes the types it could not check', () => {
    const markdown = renderPruned({dropped: [], unverified: ['Report', 'Dashboard']});
    assert.match(markdown, /> Could not check Report, Dashboard against the org/);
  });
});
