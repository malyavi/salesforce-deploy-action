import {describe, it}  from 'node:test';
import assert          from 'node:assert/strict';
import {parseManifest} from '../lib/manifest.mjs';
import {
  flowDeletions,
  inertFlow,
  parseDefinitions,
  renderRetired,
  renderRetiring,
  retireFlows,
  stageRetiringFlows
}                      from '../lib/flows.mjs';

/**
 * Retiring flows that are still active in the org.
 *
 * Two things to hold onto. The inert version changes nothing but when the flow
 * starts, so it saves exactly as the version the org already holds did. And
 * every uncertainty leaves the deletion where it was, so the org answers as it
 * would have without any of this.
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
        <members>Record_Flow</members>
        <members>Screen_Flow</members>
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

const RECORD_FLOW = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>53.0</apiVersion>
    <label>Record Flow</label>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <locationX>50</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Create_Payment</targetReference>
        </connector>
        <doesRequireRecordChangedToMeetCriteria>true</doesRequireRecordChangedToMeetCriteria>
        <filterLogic>1 OR 2</filterLogic>
        <filters>
            <field>Status__c</field>
            <operator>EqualTo</operator>
            <value>
                <stringValue>New</stringValue>
            </value>
        </filters>
        <filters>
            <field>Retry__c</field>
            <operator>EqualTo</operator>
            <value>
                <booleanValue>true</booleanValue>
            </value>
        </filters>
        <object>Invoice__c</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
    </start>
    <status>Obsolete</status>
</Flow>
`;

const SCREEN_FLOW = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <processType>Flow</processType>
    <start>
        <locationX>50</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Ask</targetReference>
        </connector>
    </start>
    <status>Active</status>
</Flow>
`;

describe('flowDeletions', () => {
  it('names the whole flows deleted, and leaves a single version alone', () => {
    assert.deepEqual(flowDeletions(DESTRUCTIVE), ['Record_Flow', 'Screen_Flow', 'Inactive_Flow']);
    assert.deepEqual(flowDeletions(PACKAGE), []);
    assert.deepEqual(flowDeletions(undefined), []);
  });
});

describe('inertFlow', () => {
  const inert = inertFlow(RECORD_FLOW);
  const start = inert.match(/<start>[\s\S]*?<\/start>/)[0];

  it('replaces the entry conditions with two that contradict each other', () => {
    assert.doesNotMatch(start, /Status__c|Retry__c|1 OR 2|doesRequireRecordChangedToMeetCriteria/);
    assert.match(start, /<filterLogic>and<\/filterLogic>/);
    assert.equal([...start.matchAll(/<field>Id<\/field>\s*<operator>IsNull<\/operator>/g)].length, 2);
    assert.match(start, /<booleanValue>true<\/booleanValue>[\s\S]*<booleanValue>false<\/booleanValue>/);
  });

  it('keeps the element order the org writes: the conditions come right before the object', () => {
    assert.match(start, /<\/connector>\s*<filterLogic>and[\s\S]*<\/filters>\s*<object>Invoice__c<\/object>/);
  });

  it('activates it, and changes nothing outside the start and the status', () => {
    assert.match(inert, /<status>Active<\/status>/);
    const outside = (xml) => xml.replace(/<start>[\s\S]*?<\/start>/, '').replace(/<status>[^<]*<\/status>/, '');
    assert.equal(outside(inert), outside(RECORD_FLOW));
  });

  it('declines a flow that does not start on a record', () => {
    assert.equal(inertFlow(SCREEN_FLOW), null);
    assert.equal(inertFlow(RECORD_FLOW.replace('RecordAfterSave', 'Scheduled')), null);
  });

  it('declines a document it cannot read with confidence', () => {
    assert.equal(inertFlow(RECORD_FLOW.replace('</Flow>', '<status>Draft</status></Flow>')), null);
    assert.equal(inertFlow(RECORD_FLOW.replace('<object>Invoice__c</object>', '')), null);
    assert.equal(inertFlow(''), null);
  });
});

describe('parseDefinitions', () => {
  it('reads each flow the org has, and which version is active', () => {
    const found = parseDefinitions(JSON.stringify({
      status: 0,
      result: {
        records: [
          {Id: '300A', DeveloperName: 'Record_Flow', ActiveVersion: {VersionNumber: 7}},
          {Id: '300B', DeveloperName: 'Inactive_Flow', ActiveVersion: null}
        ]
      }
    }));
    assert.deepEqual(found.get('Record_Flow'), {id: '300A', activeVersion: 7});
    assert.deepEqual(found.get('Inactive_Flow'), {id: '300B', activeVersion: null});
    assert.equal(found.has('Screen_Flow'), false);
  });

  it('answers null, not an empty org, when the answer cannot be read', () => {
    assert.equal(parseDefinitions('Warning: update available'), null);
    assert.equal(parseDefinitions(JSON.stringify({status: 1, message: 'nope'})), null);
  });
});

/**
 * A staging run with the org, git and the disk all stubbed.
 *
 * @param {Map<string, object>|null} org What the lookup answers
 * @return {Promise<{ staged: object, delta: object, written: Map<string, string> }>} The outcome, the delta it left, and whatever was written
 */
async function stage(org) {
  const delta = {baseSha: 'b'.repeat(40), package: PACKAGE, destructive: DESTRUCTIVE};
  const written = new Map();
  const files = {Record_Flow: RECORD_FLOW, Screen_Flow: SCREEN_FLOW};
  const staged = await stageRetiringFlows(delta, {orgAlias: 'target', sourceDirs: ['force-app'], apiVersion: '66.0'}, {
    definitions: async (names) => {
      assert.deepEqual(names, ['Record_Flow', 'Screen_Flow', 'Inactive_Flow']);
      return org;
    },
    source: async (sha, name) => files[name] ? {path: `force-app/main/default/flows/${name}.flow-meta.xml`, xml: files[name]} : null,
    write: async (path, text) => {
      written.set(path, text);
    }
  });
  return {staged, delta, written};
}

const ORG = new Map([
  ['Record_Flow', {id: '300A', activeVersion: 7}],
  ['Screen_Flow', {id: '300B', activeVersion: 2}],
  ['Inactive_Flow', {id: '300C', activeVersion: null}]
]);

describe('stageRetiringFlows', () => {
  it('takes the active flows out of the deletions and leaves the inactive one to the deployment', async () => {
    const {staged, delta} = await stage(ORG);
    assert.deepEqual(staged, {
      retiring: [{name: 'Record_Flow', inert: true}, {name: 'Screen_Flow', inert: false}],
      unverified: false
    });
    assert.deepEqual(delta.destructive.types, [
      {name: 'ApexClass', members: ['OldClass']},
      {name: 'Flow', members: ['Inactive_Flow', 'Old_Flow-3']}
    ]);
  });

  it('puts the inert version of a record-triggered flow in the package, where its file was', async () => {
    const {delta, written} = await stage(ORG);
    assert.deepEqual(delta.package.types, [
      {name: 'ApexTrigger', members: ['InvoiceTrigger']},
      {name: 'Flow', members: ['Record_Flow']}
    ]);
    assert.equal(written.get('force-app/main/default/flows/Record_Flow.flow-meta.xml'), inertFlow(RECORD_FLOW));
    assert.equal(written.has('force-app/main/default/flows/Screen_Flow.flow-meta.xml'), false);
    assert.match(written.get(PACKAGE.path), /<members>Record_Flow<\/members>/);
    assert.match(written.get(DESTRUCTIVE.path), /<version>67\.0<\/version>/);
  });

  it('changes nothing when no deleted flow is active', async () => {
    const {staged, delta, written} = await stage(new Map([['Inactive_Flow', {id: '300C', activeVersion: null}]]));
    assert.deepEqual(staged, {retiring: [], unverified: false});
    assert.equal(delta.destructive, DESTRUCTIVE);
    assert.equal(written.size, 0);
  });

  it('keeps every deletion when the org cannot be asked', async () => {
    const {staged, delta, written} = await stage(null);
    assert.deepEqual(staged, {retiring: [], unverified: true});
    assert.equal(delta.destructive, DESTRUCTIVE);
    assert.equal(written.size, 0);
  });
});

describe('retireFlows', () => {
  const config = {orgAlias: 'target', apiVersion: '67.0', waitMinutes: 30};

  it('deactivates what is active, deletes what is there, and skips what is gone', async () => {
    const deactivated = [];
    const removed = [];
    const result = await retireFlows(['Record_Flow', 'Inactive_Flow', 'Gone_Flow'], config, {
      definitions: async () => ORG,
      deactivate: async (id) => {
        deactivated.push(id);
      },
      remove: async (names) => {
        removed.push(...names);
      }
    });
    assert.deepEqual(deactivated, ['300A']);
    assert.deepEqual(removed, ['Record_Flow', 'Inactive_Flow']);
    assert.deepEqual(result, {deactivated: ['Record_Flow'], deleted: ['Record_Flow', 'Inactive_Flow']});
  });

  it('refuses rather than guesses when the org cannot be asked', async () => {
    await assert.rejects(retireFlows(['Record_Flow'], config, {definitions: async () => null}), /Could not look up Record_Flow/);
  });

  it('does nothing for no flows', async () => {
    assert.deepEqual(await retireFlows([], config, {definitions: assert.fail}), {deactivated: [], deleted: []});
  });
});

describe('the summary', () => {
  it('says nothing when no flow was involved', () => {
    assert.equal(renderRetiring({retiring: [], unverified: false}, {checkOnly: true}), '');
  });

  it('says what a check-only run left for the deployment', () => {
    const markdown = renderRetiring({retiring: [{name: 'Record_Flow', inert: true}], unverified: false}, {checkOnly: true});
    assert.match(markdown, /1 still active in the org/);
    assert.match(markdown, /The deploy action deactivates and deletes them/);
    assert.match(markdown, /\| Record_Flow \| an inert active version/);
  });

  it('reports what was retired, and why not when it failed', () => {
    const done = renderRetired(['Record_Flow', 'Gone_Flow'], {result: {deactivated: ['Record_Flow'], deleted: ['Record_Flow']}});
    assert.match(done, /\| Record_Flow \| deactivated, then deleted \|/);
    assert.match(done, /\| Gone_Flow \| already gone from the org \|/);
    assert.match(renderRetired(['Record_Flow'], {failure: 'INSUFFICIENT_ACCESS'}), /retries them[\s\S]*INSUFFICIENT_ACCESS/);
  });
});
