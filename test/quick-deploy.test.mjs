import {describe, it}                                                  from 'node:test';
import assert                                                          from 'node:assert/strict';
import {findValidation, mismatch, startedDeployment, verifyValidation} from '../lib/quick-deploy.mjs';
import {summaryAfresh, summarySucceeded}                               from '../lib/report.mjs';
import {newDeployId}                                                   from '../lib/salesforce.mjs';
import {
  ageInDays,
  isExpired,
  parseRecord,
  readValidationRecord,
  renderRecord,
  sweepValidationRecords,
  validationTag,
  VALIDATION_MAX_AGE_DAYS
}                                                                      from '../lib/validation-record.mjs';

/**
 * Whether a recorded validation may stand in for a deployment. The wrong
 * answer in one direction re-runs half an hour of tests; in the other it
 * deploys a package that is not the one in hand — so every reason to say no
 * is spelled out, and the reader is told which one applied.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-28T12:00:00Z');

const record = {
  deployId: '0AfXX00000ABCDEFGH',
  validatedAt: new Date(NOW - 2 * DAY).toISOString(),
  baseSha: 'b'.repeat(40),
  baseTree: 'B'.repeat(40),
  headSha: 'h'.repeat(40),
  headTree: 'H'.repeat(40),
  sourceDirs: ['force-app', 'malyavi-app'],
  destructive: 'post',
  ignoreWhitespace: true,
  testLevel: 'RunLocalTests'
};

const config = {
  validationTagPrefix: 'ci/validated',
  environment: 'main',
  sourceDirs: ['malyavi-app', 'force-app'],
  destructive: 'post',
  ignoreWhitespace: true,
  testLevel: 'RunLocalTests'
};

describe('the record', () => {
  it('is named by the tree, under the environment', () => {
    assert.equal(validationTag('ci/validated', 'main', 'H'.repeat(40)), `ci/validated/main/${'H'.repeat(40)}`);
    assert.equal(validationTag('ci/validated', '', 'H'.repeat(40)), `ci/validated/${'H'.repeat(40)}`);
  });

  it('survives a round trip through the tag message', () => {
    assert.deepEqual(parseRecord(renderRecord(record)), record);
  });

  it('refuses a message that is not a record, rather than guessing at the missing fields', () => {
    assert.equal(parseRecord('Release 1.0'), null);
    assert.equal(parseRecord('[]'), null);
    assert.equal(parseRecord(JSON.stringify({...record, baseTree: undefined})), null);
    assert.equal(parseRecord(JSON.stringify({...record, sourceDirs: 'force-app'})), null);
  });

  it('expires when the org would no longer honour it', () => {
    assert.equal(isExpired(record, NOW), false);
    assert.equal(isExpired({validatedAt: new Date(NOW - (VALIDATION_MAX_AGE_DAYS + 1) * DAY).toISOString()}, NOW), true);
    assert.equal(ageInDays({validatedAt: 'yesterday'}, NOW), Infinity);
    assert.equal(isExpired({validatedAt: 'yesterday'}, NOW), true);
  });

  it('is read only from an annotated tag, since a lightweight one carries no message', async () => {
    const read = (type) => readValidationRecord('ci/validated/main/x', {
      ref: async () => ({sha: 'obj', type}),
      object: async () => ({message: renderRecord(record), object: {sha: record.headSha, type: 'commit'}, date: null})
    });
    assert.deepEqual(await read('tag'), record);
    assert.equal(await read('commit'), null);
  });

  it('is absent, not an error, when there is no such tag', async () => {
    assert.equal(await readValidationRecord('ci/validated/main/x', {ref: async () => null}), null);
  });
});

describe('sweepValidationRecords', () => {
  it('deletes the expired records and leaves the rest, and what it cannot date', async () => {
    const stale = {...record, validatedAt: new Date(NOW - 11 * DAY).toISOString()};
    const objects = {
      fresh: {message: renderRecord(record), date: null},
      stale: {message: renderRecord(stale), date: null},
      undated: {message: 'not a record', date: null},
      datedByTagger: {message: 'not a record', date: new Date(NOW - 30 * DAY).toISOString()}
    };
    const removed = [];
    const deleted = await sweepValidationRecords('ci/validated', 'main', {
      now: NOW,
      list: async (prefix) => {
        assert.equal(prefix, 'ci/validated/main/');
        return [
          {tag: 'ci/validated/main/fresh', sha: 'fresh', type: 'tag'},
          {tag: 'ci/validated/main/stale', sha: 'stale', type: 'tag'},
          {tag: 'ci/validated/main/undated', sha: 'undated', type: 'tag'},
          {tag: 'ci/validated/main/old', sha: 'datedByTagger', type: 'tag'},
          {tag: 'ci/validated/main/light', sha: 'commit', type: 'commit'}
        ];
      },
      object: async (sha) => objects[sha] ?? null,
      remove: async (tag) => {
        removed.push(tag);
        return true;
      }
    });
    assert.deepEqual(deleted, ['ci/validated/main/stale', 'ci/validated/main/old']);
    assert.deepEqual(removed, deleted);
  });

  it('deletes nothing when the tags cannot be listed', async () => {
    assert.deepEqual(await sweepValidationRecords('ci/validated', 'main', {list: async () => null}), []);
  });
});

describe('mismatch', () => {
  const delta = {baseTree: record.baseTree};

  it('accepts the same package: same trees, same directories in any order, same options', () => {
    assert.equal(mismatch(record, delta, config, NOW), null);
  });

  it('refuses a validation diffed from a tree the org does not have', () => {
    // The org has what the anchor points at; a validation from anywhere else
    // describes a package that is not this delta, whichever way it differs.
    assert.match(mismatch(record, {baseTree: 'X'.repeat(40)}, config, NOW), /different tree/);
  });

  it('refuses a validation over other directories', () => {
    assert.match(mismatch(record, delta, {...config, sourceDirs: ['force-app']}, NOW), /covered `force-app\/` and `malyavi-app\/` rather than `force-app\/`/);
  });

  it('refuses a validation that treated deletions or whitespace differently', () => {
    assert.match(mismatch(record, delta, {...config, destructive: 'pre'}, NOW), /`post` rather than `pre`/);
    assert.match(mismatch(record, delta, {...config, ignoreWhitespace: false}, NOW), /ignored whitespace-only changes/);
  });

  it('refuses a validation that ran fewer tests than the deployment asks for, and accepts more', () => {
    assert.match(mismatch({...record, testLevel: 'NoTestRun'}, delta, config, NOW), /ran `NoTestRun`, and this deployment asks for `RunLocalTests`/);
    assert.equal(mismatch({...record, testLevel: 'RunAllTestsInOrg'}, delta, config, NOW), null);
  });

  it('refuses a validation the org will have forgotten', () => {
    const old = {...record, validatedAt: new Date(NOW - 12 * DAY).toISOString()};
    assert.match(mismatch(old, delta, config, NOW), /12 days old, and the org keeps a validation for 10/);
    assert.match(mismatch({...record, validatedAt: '?'}, delta, config, NOW), /no readable date/);
  });
});

describe('findValidation', () => {
  const delta = {baseSha: record.baseSha, headSha: 'c'.repeat(40)};
  const trees = {[record.baseSha]: record.baseTree, [delta.headSha]: record.headTree};

  it('finds the record by the head tree and hands it over when it covers the delta', async () => {
    const found = await findValidation(delta, config, {
      tree: async (sha) => trees[sha],
      read: async (tag) => (tag === validationTag('ci/validated', 'main', record.headTree) ? record : null),
      now: NOW
    });
    assert.equal(found.record, record);
    assert.equal(found.tag, `ci/validated/main/${record.headTree}`);
  });

  it('says which tag it looked for when there is none', async () => {
    const found = await findValidation(delta, config, {tree: async (sha) => trees[sha], read: async () => null, now: NOW});
    assert.equal(found.record, undefined);
    assert.match(found.reason, /no validation is recorded for this tree \(`ci\/validated\/main\//);
  });

  it('names the validation and the reason when one exists and does not cover the delta', async () => {
    const found = await findValidation(delta, config, {
      tree: async (sha) => trees[sha],
      read: async () => ({...record, destructive: 'ignore'}),
      now: NOW
    });
    assert.match(found.reason, /validation `0AfXX00000ABCDEFGH` \(`ci\/validated\/main\/H+`\) handled deletions as `ignore`/);
  });

  it('gives up, saying so, when git cannot answer for a tree', async () => {
    const found = await findValidation(delta, config, {tree: async () => null, read: async () => record, now: NOW});
    assert.match(found.reason, /could not be read from git/);
  });
});

describe('verifyValidation', () => {
  const report = (result) => async () => (result ? {status: 0, result} : null);

  it('accepts a validation the org reports as succeeded', async () => {
    assert.equal(await verifyValidation('0AfXX00000ABCDEFGH', 'target', {report: report({checkOnly: true, status: 'Succeeded'})}), null);
  });

  it('refuses one the org does not have, which is how a wrong org shows up', async () => {
    assert.match(await verifyValidation('0AfXX00000ABCDEFGH', 'target', {report: report(null)}), /no record of validation/);
  });

  it('refuses a real deployment and a validation that did not succeed', async () => {
    assert.match(await verifyValidation('0AfXX00000ABCDEFGH', 'target', {report: report({checkOnly: false, status: 'Succeeded'})}), /is a deployment, not a validation/);
    assert.match(await verifyValidation('0AfXX00000ABCDEFGH', 'target', {report: report({checkOnly: true, status: 'Failed'})}), /as Failed/);
  });
});

describe('a failed quick deploy', () => {
  const validation = '0AfXX00000ABCDEFGH';

  it('was refused when the transcript names no deployment but the validation itself', () => {
    assert.equal(startedDeployment(`Error: The validation ${validation} has expired.`, validation), false);
    assert.equal(startedDeployment('', validation), false);
  });

  it('is a verdict when the org started a deployment and it failed', () => {
    assert.equal(startedDeployment(`Promoting ${validation}\nDeploy ID: 0AfXX00000NEWNEWNE\nStatus: Failed`, validation), true);
  });

  it('reports the new deployment\'s id, never the validation\'s', () => {
    assert.equal(newDeployId(`Promoting ${validation}\nDeploy ID: 0AfXX00000NEWNEWNE`, validation), '0AfXX00000NEWNEWNE');
    assert.equal(newDeployId(`Promoting ${validation}`, validation), undefined);
    assert.equal(newDeployId(`Deploy ID: ${validation}`), validation);
  });
});

describe('the summaries', () => {
  it('say a promoted run ran no tests, in place of a test level that would suggest it did', () => {
    const summary = summarySucceeded(
      {environment: 'production', testLevel: 'RunLocalTests', checkOnly: false},
      {label: 'the delta', promotedFrom: '0AfXX00000ABCDEFGH'},
      {anchored: false}
    );
    assert.match(summary, /Promoted from validation `0AfXX00000ABCDEFGH`/);
    assert.match(summary, /none ran again/);
    assert.equal(summary.includes('RunLocalTests'), false);
  });

  it('say why a run that could have been promoted was not', () => {
    assert.equal(
      summaryAfresh('no validation is recorded for this tree'),
      ':information_source: Deployed afresh, with its tests: no validation is recorded for this tree.'
    );
  });
});
