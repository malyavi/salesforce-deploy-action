import {describe, it}  from 'node:test';
import assert          from 'node:assert/strict';
import {parseManifest} from '../lib/manifest.mjs';
import {
  definitionPath,
  flowDeletions,
  parseVersions,
  renderDefinition,
  renderFlowDeletions,
  stageFlowDeletions
}                      from '../lib/flows.mjs';

/**
 * Rewriting flow deletions into ones the org accepts.
 *
 * The org deletes a flow version by version and refuses to delete an active
 * one. Everything here exists to say that in the package, and every
 * uncertainty leaves the deletion as sfdx-git-delta wrote it, so the org
 * answers as it would have without any of this.
 */

const manifestOf = (path, xml) => ({path, ...parseManifest(xml)});

const PACKAGE = manifestOf('.delta/package/package.xml', `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>InvoiceTrigger</members>
        <name>ApexTrigger</name>
    </types>
    <version>67.0</version>
</Package>
`);

const DESTRUCTIVE = manifestOf('.delta/destructiveChanges/destructiveChanges.xml', `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>Active_Flow</members>
        <members>Inactive_Flow</members>
        <members>Old_Flow-3</members>
        <name>Flow</name>
    </types>
    <types>
        <members>OldClass</members>
        <name>ApexClass</name>
    </types>
    <version>67.0</version>
</Package>
`);

/** What the org holds: `Active_Flow` has three versions with the third active, `Inactive_Flow` two inactive ones. */
const ORG = new Map([
  ['Active_Flow', {versions: [1, 2, 3], active: 3}],
  ['Inactive_Flow', {versions: [1, 2], active: null}]
]);

describe('flowDeletions', () => {
  it('names the whole flows deleted, and leaves a single version alone', () => {
    assert.deepEqual(flowDeletions(DESTRUCTIVE), ['Active_Flow', 'Inactive_Flow']);
    assert.deepEqual(flowDeletions(PACKAGE), []);
    assert.deepEqual(flowDeletions(undefined), []);
  });
});

describe('parseVersions', () => {
  it('groups the versions by flow, in order, and notes the active one', () => {
    const found = parseVersions(JSON.stringify({
      status: 0,
      result: {
        records: [
          {VersionNumber: 3, Status: 'Active', Definition: {DeveloperName: 'Active_Flow'}},
          {VersionNumber: 1, Status: 'Obsolete', Definition: {DeveloperName: 'Active_Flow'}},
          {VersionNumber: 2, Status: 'Draft', Definition: {DeveloperName: 'Active_Flow'}},
          {VersionNumber: 1, Status: 'Obsolete', Definition: {DeveloperName: 'Inactive_Flow'}}
        ]
      }
    }));
    assert.deepEqual(found.get('Active_Flow'), {versions: [1, 2, 3], active: 3});
    assert.deepEqual(found.get('Inactive_Flow'), {versions: [1], active: null});
    assert.equal(found.has('Gone_Flow'), false);
  });

  it('answers null, not an empty org, when the answer cannot be read', () => {
    assert.equal(parseVersions('Warning: update available'), null);
    assert.equal(parseVersions(JSON.stringify({status: 1, message: 'nope'})), null);
  });
});

describe('definitionPath', () => {
  it('puts the definition beside the flows directory the flow was in', () => {
    assert.equal(
      definitionPath('force-app/main/default/flows/Active_Flow.flow-meta.xml', 'Active_Flow', ['force-app']),
      'force-app/main/default/flowDefinitions/Active_Flow.flowDefinition-meta.xml'
    );
  });

  it('falls back to the first source directory when the flow cannot be found', () => {
    assert.equal(
      definitionPath(null, 'Active_Flow', ['other-app', 'force-app']),
      'other-app/main/default/flowDefinitions/Active_Flow.flowDefinition-meta.xml'
    );
  });
});

/**
 * A staging run with the org, git and the disk all stubbed.
 *
 * @param {Map<string, object>|null} org What the lookup answers
 * @param {string[]} [onDisk] Files that already exist
 * @return {Promise<{ staged: object, delta: object, written: Map<string, string> }>} The outcome, the delta it left, and whatever was written
 */
async function stage(org, onDisk = []) {
  const delta = {baseSha: 'b'.repeat(40), package: PACKAGE, destructive: DESTRUCTIVE};
  const written = new Map();
  const staged = await stageFlowDeletions(delta, {orgAlias: 'target', sourceDirs: ['force-app'], apiVersion: '66.0'}, {
    versions: async (names) => {
      assert.deepEqual(names, ['Active_Flow', 'Inactive_Flow']);
      return org;
    },
    source: async (sha, name) => `force-app/main/default/flows/${name}.flow-meta.xml`,
    exists: async (path) => onDisk.includes(path),
    write: async (path, text) => {
      written.set(path, text);
    }
  });
  return {staged, delta, written};
}

const DEFINITION = 'force-app/main/default/flowDefinitions/Active_Flow.flowDefinition-meta.xml';

describe('stageFlowDeletions', () => {
  it('deletes every version of each flow, and leaves a single version and other types alone', async () => {
    const {staged, delta} = await stage(ORG);
    assert.deepEqual(staged, {
      flows: [
        {name: 'Active_Flow', versions: [1, 2, 3], deactivated: true},
        {name: 'Inactive_Flow', versions: [1, 2], deactivated: false}
      ],
      unverified: false
    });
    assert.deepEqual(delta.destructive.types, [
      {name: 'ApexClass', members: ['OldClass']},
      {name: 'Flow', members: ['Active_Flow-1', 'Active_Flow-2', 'Active_Flow-3', 'Inactive_Flow-1', 'Inactive_Flow-2', 'Old_Flow-3']}
    ]);
  });

  it('deactivates an active flow with a FlowDefinition in the same package', async () => {
    const {delta, written} = await stage(ORG);
    assert.deepEqual(delta.package.types, [
      {name: 'ApexTrigger', members: ['InvoiceTrigger']},
      {name: 'FlowDefinition', members: ['Active_Flow']}
    ]);
    assert.equal(written.get(DEFINITION), renderDefinition());
    assert.match(renderDefinition(), /<activeVersionNumber>0<\/activeVersionNumber>/);
    assert.match(written.get(PACKAGE.path), /<members>Active_Flow<\/members>\s*<name>FlowDefinition<\/name>/);
    assert.match(written.get(DESTRUCTIVE.path), /<version>67\.0<\/version>/);
  });

  it('keeps a FlowDefinition the change already carries', async () => {
    const {delta, written} = await stage(ORG, [DEFINITION]);
    assert.equal(written.has(DEFINITION), false);
    assert.deepEqual(delta.package.types.find((type) => type.name === 'FlowDefinition'), {name: 'FlowDefinition', members: ['Active_Flow']});
  });

  it('leaves the package alone when no deleted flow is active', async () => {
    const {delta, written} = await stage(new Map([['Inactive_Flow', {versions: [1, 2], active: null}]]));
    assert.equal(delta.package, PACKAGE);
    assert.equal(written.has(PACKAGE.path), false);
    assert.deepEqual(delta.destructive.types.find((type) => type.name === 'Flow').members, ['Active_Flow', 'Inactive_Flow-1', 'Inactive_Flow-2', 'Old_Flow-3']);
  });

  it('keeps every deletion as it was when the org cannot be asked', async () => {
    const {staged, delta, written} = await stage(null);
    assert.deepEqual(staged, {flows: [], unverified: true});
    assert.equal(delta.destructive, DESTRUCTIVE);
    assert.equal(written.size, 0);
  });
});

describe('the summary', () => {
  it('says nothing when no flow was involved', () => {
    assert.equal(renderFlowDeletions({flows: [], unverified: false}), '');
  });

  it('lists the versions deleted and whether each flow was deactivated first', () => {
    const markdown = renderFlowDeletions({flows: [{name: 'Active_Flow', versions: [1, 2, 3], deactivated: true}], unverified: false});
    assert.match(markdown, /1 rewritten/);
    assert.match(markdown, /\| Active_Flow \| 1, 2, 3 \| yes \|/);
  });

  it('says when the org could not be asked', () => {
    assert.match(renderFlowDeletions({flows: [], unverified: true}), /left as they were/);
  });
});
