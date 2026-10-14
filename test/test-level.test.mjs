import {describe, it}                              from 'node:test';
import assert                                      from 'node:assert/strict';
import {parseManifest}                             from '../lib/manifest.mjs';
import {isUiOnly, resolveTestLevel, UI_ONLY_TYPES} from '../lib/test-level.mjs';

/**
 * When a run gets to leave the Apex tests out: only when nothing in the delta
 * is something an Apex test could observe.
 *
 * Both actions in this family ship this file unchanged, as they do the module
 * it tests.
 */

const config = {testLevel: 'RunLocalTests', tests: []};

const manifest = (...types) => parseManifest(
  types.map(([name, member]) => `<types><members>${member}</members><name>${name}</name></types>`).join('')
);

const deltaOf = (pkg, destructive = parseManifest(''), extraChanged = false) => ({
  package: pkg,
  destructive,
  extraChanged
});

describe('isUiOnly', () => {
  it('is true for a delta of components, pages and templates alone', () => {
    const delta = deltaOf(manifest(
      ['LightningComponentBundle', 'contactList'],
      ['AuraDefinitionBundle', 'oldList'],
      ['ApexPage', 'Invoice'],
      ['ApexComponent', 'InvoiceHeader'],
      ['EmailTemplate', 'Sales/Welcome']
    ));
    assert.equal(isUiOnly(delta), true);
  });

  it('counts a deletion of UI metadata as UI too', () => {
    const delta = deltaOf(parseManifest(''), manifest(['LightningComponentBundle', 'retired']));
    assert.equal(isUiOnly(delta), true);
  });

  it('is false the moment anything else is in the delta', () => {
    // One class beside a hundred components, and the tests have to run: the
    // class is what they can observe.
    const delta = deltaOf(manifest(['LightningComponentBundle', 'contactList'], ['ApexClass', 'ContactService']));
    assert.equal(isUiOnly(delta), false);
  });

  it('is false when the deletion is not UI, even if the additions are', () => {
    const delta = deltaOf(manifest(['ApexPage', 'Invoice']), manifest(['CustomField', 'Account.Region__c']));
    assert.equal(isUiOnly(delta), false);
  });

  it('is false for an empty delta, which is nothing rather than UI', () => {
    assert.equal(isUiOnly(deltaOf(parseManifest(''))), false);
  });

  it('is false when an extra directory was folded in, since the org sees more than the delta', () => {
    const delta = deltaOf(manifest(['ApexPage', 'Invoice']), parseManifest(''), true);
    assert.equal(isUiOnly(delta), false);
  });

  it('is false for a run with no delta, whose placeholder lists no types', () => {
    // What the validation action stands in for the delta when `delta` is
    // off, and what a full deployment has: a whole directory, not a list.
    assert.equal(isUiOnly({package: {isEmpty: false}, destructive: {isEmpty: true}}), false);
    assert.equal(isUiOnly({}), false);
  });

  it('treats a static resource as something a test might reach', () => {
    // Not on the list on purpose: a static resource is anything zipped, and
    // Apex can read one.
    assert.equal(UI_ONLY_TYPES.includes('StaticResource'), false);
    assert.equal(isUiOnly(deltaOf(manifest(['StaticResource', 'd3']))), false);
  });
});

describe('resolveTestLevel', () => {
  const uiDelta = deltaOf(manifest(['LightningComponentBundle', 'contactList'], ['ApexPage', 'Invoice']));

  it('drops to NoTestRun for a UI-only delta and says why, naming the types', () => {
    const testing = resolveTestLevel(uiDelta, config);
    assert.equal(testing.testLevel, 'NoTestRun');
    assert.equal(testing.skipped, true);
    assert.match(testing.reason, /Apex tests skipped/);
    assert.match(testing.reason, /`ApexPage`, `LightningComponentBundle`/);
    assert.match(testing.reason, /`RunLocalTests` was asked for/);
  });

  it('drops the named tests with the level, since --tests is only valid with RunSpecifiedTests', () => {
    const specified = {testLevel: 'RunSpecifiedTests', tests: ['ContactServiceTest']};
    const testing = resolveTestLevel(uiDelta, specified);
    assert.equal(testing.testLevel, 'NoTestRun');
    assert.deepEqual(testing.tests, []);
  });

  it('keeps the configured level, and its tests, for anything else', () => {
    const delta = deltaOf(manifest(['ApexClass', 'ContactService']));
    const specified = {testLevel: 'RunSpecifiedTests', tests: ['ContactServiceTest']};
    const testing = resolveTestLevel(delta, specified);
    assert.equal(testing.testLevel, 'RunSpecifiedTests');
    assert.deepEqual(testing.tests, ['ContactServiceTest']);
    assert.equal(testing.skipped, false);
    assert.equal(testing.reason, '');
  });

  it('has nothing to skip when no tests were asked for', () => {
    const testing = resolveTestLevel(uiDelta, {testLevel: 'NoTestRun', tests: []});
    assert.equal(testing.skipped, false);
    assert.equal(testing.testLevel, 'NoTestRun');
  });
});
