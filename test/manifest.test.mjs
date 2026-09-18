import {describe, it} from 'node:test';
import assert          from 'node:assert/strict';
import {
  parseManifest,
  renderDeltaSummary,
  renderManifest,
  renderPackageXml,
  splitManifest,
  versionOf
}                      from '../lib/manifest.mjs';

/**
 * Reading and writing the manifests, which are the whole of what the org is
 * asked to look at.
 */

const DELTA = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>AccountService</members>
        <members>AccountController</members>
        <name>ApexClass</name>
    </types>
    <types>
        <members>Account.Region__c</members>
        <name>CustomField</name>
    </types>
    <version>67.0</version>
</Package>
`;

describe('parseManifest', () => {
  it('reads the types and their members, sorted by type', () => {
    const manifest = parseManifest(DELTA);
    assert.deepEqual(manifest.types.map((type) => type.name), ['ApexClass', 'CustomField']);
    assert.deepEqual(manifest.types[0].members, ['AccountService', 'AccountController']);
    assert.equal(manifest.componentCount, 3);
    assert.equal(manifest.isEmpty, false);
  });

  it('reads an absent manifest as empty rather than as a failure', () => {
    // sfdx-git-delta omits the file entirely when there is nothing of that
    // kind, so "missing" is the normal case rather than an error.
    const manifest = parseManifest('');
    assert.equal(manifest.isEmpty, true);
    assert.equal(manifest.componentCount, 0);
  });

  it('ignores a types block with no name', () => {
    assert.equal(parseManifest('<types><members>X</members></types>').isEmpty, true);
  });
});

describe('versionOf', () => {
  it('reads the declared version', () => {
    assert.equal(versionOf(DELTA), '67.0');
  });

  it('answers null when there is none, rather than a made-up default', () => {
    assert.equal(versionOf('<Package></Package>'), null);
  });
});

describe('renderPackageXml', () => {
  it('round-trips through the parser', () => {
    const parsed = parseManifest(DELTA);
    const rendered = renderPackageXml(parsed.types, '67.0');
    const reparsed = parseManifest(rendered);
    assert.deepEqual(reparsed.types, parsed.types);
    assert.equal(versionOf(rendered), '67.0');
  });

  it('writes a valid document for no types at all', () => {
    // What a fully pruned destructive manifest becomes; the Metadata API
    // accepts it and deletes nothing.
    const rendered = renderPackageXml([], '67.0');
    assert.match(rendered, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(rendered, /<version>67\.0<\/version>/);
    assert.equal(parseManifest(rendered).isEmpty, true);
  });
});

describe('splitManifest', () => {
  const manifest = parseManifest(DELTA);

  it('calls a member added only when every file of it was added', () => {
    const changes = [
      {status: 'A', path: 'force-app/main/default/classes/AccountService.cls'},
      {status: 'A', path: 'force-app/main/default/classes/AccountService.cls-meta.xml'},
      {status: 'M', path: 'force-app/main/default/classes/AccountController.cls'},
      {status: 'A', path: 'force-app/main/default/objects/Account/fields/Region__c.field-meta.xml'}
    ];
    const {added, modified} = splitManifest(manifest, changes);
    assert.deepEqual(added.types.find((type) => type.name === 'ApexClass').members, ['AccountService']);
    assert.deepEqual(modified.types.find((type) => type.name === 'ApexClass').members, ['AccountController']);
    assert.deepEqual(added.types.find((type) => type.name === 'CustomField').members, ['Account.Region__c']);
  });

  it('does not match one object\'s field against another object\'s', () => {
    // `Region__c` exists on several objects; the object is a directory in the
    // path, and without checking it every one of them matches every other.
    const {added, modified} = splitManifest(parseManifest(DELTA), [
      {status: 'A', path: 'force-app/main/default/objects/Contact/fields/Region__c.field-meta.xml'}
    ]);
    assert.equal(added.types.some((type) => type.name === 'CustomField'), false);
    assert.deepEqual(modified.types.find((type) => type.name === 'CustomField').members, ['Account.Region__c']);
  });

  it('calls a member modified when nothing matched, which is the safer claim', () => {
    const {added, modified} = splitManifest(manifest, []);
    assert.equal(added.isEmpty, true);
    assert.equal(modified.componentCount, 3);
  });

  it('matches a bundle by its directory', () => {
    const bundle = parseManifest('<types><members>contactList</members><name>LightningComponentBundle</name></types>');
    const {added} = splitManifest(bundle, [
      {status: 'A', path: 'force-app/main/default/lwc/contactList/contactList.js'},
      {status: 'A', path: 'force-app/main/default/lwc/contactList/contactList.html'}
    ]);
    assert.deepEqual(added.types[0].members, ['contactList']);
  });

  it('handles an empty manifest without inventing halves', () => {
    const {added, modified} = splitManifest(parseManifest(''), []);
    assert.equal(added.isEmpty, true);
    assert.equal(modified.isEmpty, true);
  });
});

describe('renderManifest', () => {
  it('counts components and pluralizes the heading', () => {
    assert.match(renderManifest('Added', parseManifest(DELTA)), /### Added — 3 components/);
    const one = parseManifest('<types><members>A</members><name>ApexClass</name></types>');
    assert.match(renderManifest('Added', one), /### Added — 1 component$/m);
  });

  it('caps the member list and says how many it left out', () => {
    const members = Array.from({length: 20}, (unused, index) => `<members>C${index}</members>`).join('');
    const manifest = parseManifest(`<types>${members}<name>ApexClass</name></types>`);
    assert.match(renderManifest('Added', manifest), /…and 5 more/);
  });

  it('puts the document itself behind a disclosure when there is one', () => {
    assert.match(renderManifest('Added', parseManifest(DELTA)), /<details><summary>Generated manifest<\/summary>/);
  });
});

describe('renderDeltaSummary', () => {
  const delta = {
    baseSha: 'a'.repeat(40),
    package: parseManifest(DELTA),
    ...splitManifest(parseManifest(DELTA), [{status: 'A', path: 'force-app/classes/AccountService.cls'}]),
    destructive: parseManifest('<types><members>Old</members><name>ApexClass</name></types>')
  };

  it('shortens the base commit and names the environment', () => {
    const summary = renderDeltaSummary(delta, {environment: 'staging'});
    assert.match(summary, /^## Delta against `aaaaaaa` \(staging\)/);
  });

  it('renders the three groups it has', () => {
    const summary = renderDeltaSummary(delta, {});
    assert.match(summary, /### Added/);
    assert.match(summary, /### Modified/);
    assert.match(summary, /### Deleted/);
  });

  it('falls back to one group when no split was made', () => {
    const summary = renderDeltaSummary({baseSha: 'HEAD~1', package: parseManifest(DELTA)}, {});
    assert.match(summary, /### Added and modified/);
  });

  it('lists the directories validated whole, and says they are not deployed', () => {
    const summary = renderDeltaSummary(
      {...delta, extraChanged: true, extraFiles: ['unpackaged-setup/x.xml']},
      {extraDirs: ['unpackaged-setup']}
    );
    assert.match(summary, /### Validated whole \(`unpackaged-setup\/`\)/);
    assert.match(summary, /- `unpackaged-setup\/x\.xml`/);
    assert.match(summary, /\*\*Nothing here is deployed\*\*/);
  });

  it('leaves a non-SHA base alone rather than truncating it to seven characters', () => {
    assert.match(renderDeltaSummary({baseSha: 'HEAD~1', package: parseManifest('')}, {}), /`HEAD~1`/);
  });
});
