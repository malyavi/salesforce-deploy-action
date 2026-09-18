import {afterEach, describe, it}                           from 'node:test';
import assert                                               from 'node:assert/strict';
import {anchorTag, recordDeployed}                          from '../lib/anchor.mjs';
import {MODES, resolveConfig, resolveCredentials, TEST_LEVELS} from '../lib/config.mjs';
import {isEmpty, resolveRange, resolveScope}                from '../lib/delta.mjs';
import {ConfigError}                                        from '../lib/inputs.mjs';
import {
  summaryFailed,
  summaryFull,
  summaryNothing,
  summarySucceeded,
  verb
}                                                           from '../lib/report.mjs';
import {deployIdFrom, toPem}                                from '../lib/salesforce.mjs';
import {versioned}                                          from '../lib/toolchain.mjs';

/**
 * Everything the action decides before it touches an org, and what it says
 * afterwards. The anchor is the part with teeth: get it wrong and a later
 * deployment quietly stops carrying components nobody noticed were missing.
 */

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) {
      delete process.env[key];
    }
  }
  delete process.env.GITHUB_SHA;
  delete process.env.GITHUB_REF_NAME;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
});

const withJwt = () => {
  process.env.INPUT_JWT_KEY = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
  process.env.INPUT_USERNAME = 'ci@example.com';
  process.env.INPUT_CLIENT_ID = '3MVG9abc';
};

describe('resolveConfig', () => {
  it('defaults to a delta of force-app with the org\'s local tests', async () => {
    withJwt();
    const config = await resolveConfig();
    assert.equal(config.mode, 'delta');
    assert.equal(config.checkOnly, false);
    assert.deepEqual(config.sourceDirs, ['force-app']);
    assert.equal(config.testLevel, 'RunLocalTests');
    assert.equal(config.moveAnchor, true);
    assert.equal(config.tagPrefix, 'ci/deployed');
  });

  it('names the environment after the branch being deployed', async () => {
    withJwt();
    process.env.GITHUB_REF_NAME = 'main';
    assert.equal((await resolveConfig()).environment, 'main');
  });

  it('refuses an unknown mode, listing the two there are', async () => {
    withJwt();
    process.env.INPUT_MODE = 'everything';
    await assert.rejects(() => resolveConfig(), (thrown) => {
      assert.ok(thrown instanceof ConfigError);
      for (const mode of MODES) {
        assert.match(thrown.message, new RegExp(mode));
      }
      return true;
    });
  });

  it('refuses a test level the Metadata API does not have', async () => {
    withJwt();
    process.env.INPUT_TEST_LEVEL = 'RunSomeTests';
    await assert.rejects(() => resolveConfig(), (thrown) => {
      for (const level of TEST_LEVELS) {
        assert.match(thrown.message, new RegExp(level));
      }
      return true;
    });
  });

  it('refuses RunSpecifiedTests with no tests named', async () => {
    withJwt();
    process.env.INPUT_TEST_LEVEL = 'RunSpecifiedTests';
    await assert.rejects(() => resolveConfig(), /needs the `tests` input/);
  });
});

describe('resolveCredentials', () => {
  it('names every missing input rather than failing at the login', () => {
    assert.throws(() => resolveCredentials('target'), (thrown) => {
      assert.match(thrown.message, /`jwt-key`/);
      assert.match(thrown.message, /`username`/);
      assert.match(thrown.message, /`client-id`/);
      assert.match(thrown.message, /auth-url/);
      return true;
    });
  });

  it('takes an sfdx auth URL instead', () => {
    process.env.INPUT_AUTH_URL = 'force://PlatformCLI::token@example.my.salesforce.com';
    assert.match(resolveCredentials('target').authUrl, /^force:\/\//);
  });
});

describe('anchorTag', () => {
  it('composes the prefix and the environment', () => {
    assert.equal(anchorTag({tagPrefix: 'ci/deployed', environment: 'main', anchorTag: ''}), 'ci/deployed/main');
  });

  it('uses the prefix alone when there is no environment', () => {
    assert.equal(anchorTag({tagPrefix: 'ci/deployed', environment: '', anchorTag: ''}), 'ci/deployed');
  });

  it('lets an explicit tag win, for a name the two do not compose', () => {
    assert.equal(
      anchorTag({tagPrefix: 'ci/deployed', environment: 'main', anchorTag: 'live'}),
      'live'
    );
  });
});

describe('recordDeployed', () => {
  it('does not move the anchor for a check-only run', async () => {
    // Nothing reached the org, so the anchor would be claiming a deployment
    // that never happened — and the next real delta would start too late.
    assert.equal(
      await recordDeployed('a'.repeat(40), {tag: 'ci/deployed/main', checkOnly: true, moveAnchor: true}),
      false
    );
  });

  it('does not move it when the caller turned that off', async () => {
    assert.equal(
      await recordDeployed('a'.repeat(40), {tag: 'ci/deployed/main', checkOnly: false, moveAnchor: false}),
      false
    );
  });

  it('does not move it with no commit to point at', async () => {
    assert.equal(
      await recordDeployed(undefined, {tag: 'ci/deployed/main', checkOnly: false, moveAnchor: true}),
      false
    );
  });

  it('answers false rather than throwing when the API is unavailable', async () => {
    // The deployment it records has already succeeded; failing the run here
    // would send somebody to repair something that is not broken.
    assert.equal(
      await recordDeployed('a'.repeat(40), {tag: 'ci/deployed/main', checkOnly: false, moveAnchor: true}),
      false
    );
  });
});

describe('resolveRange', () => {
  it('prefers the caller\'s explicit base', async () => {
    const range = await resolveRange({baseSha: 'abc123', headSha: 'def456'});
    assert.equal(range.baseSha, 'abc123');
    assert.match(range.baseSource, /`base-sha`/);
  });

  it('deploys the commit the workflow is running for', async () => {
    process.env.GITHUB_SHA = 'f'.repeat(40);
    assert.equal((await resolveRange({baseSha: 'abc', headSha: ''})).headSha, 'f'.repeat(40));
  });

  it('falls back to the push\'s own before when there is no anchor', async () => {
    const range = await resolveRange({
      baseSha: '',
      headSha: 'f'.repeat(40),
      beforeSha: 'a'.repeat(40),
      tagPrefix: 'ci/deployed',
      environment: 'main',
      anchorTag: ''
    });
    assert.equal(range.baseSha, 'a'.repeat(40));
    assert.match(range.baseSource, /previous commit/);
  });

  it('ignores the all-zero before of a branch that did not exist', async () => {
    await assert.rejects(
      () => resolveRange({
        baseSha: '',
        headSha: 'f'.repeat(40),
        beforeSha: '0'.repeat(40),
        tagPrefix: 'ci/deployed',
        environment: 'main',
        anchorTag: ''
      }),
      /Could not resolve a base commit/
    );
  });

  it('refuses with advice when there is no commit to deploy at all', async () => {
    await assert.rejects(() => resolveRange({baseSha: 'abc', headSha: ''}), (thrown) => {
      assert.ok(thrown instanceof ConfigError);
      assert.match(thrown.message, /`head-sha`/);
      return true;
    });
  });
});

describe('resolveScope', () => {
  const delta = {
    package: {path: '.delta/package/package.xml', isEmpty: false},
    destructive: {path: '.delta/destructiveChanges/destructiveChanges.xml', isEmpty: false}
  };

  it('deploys the manifest with the deletions after it', () => {
    const scope = resolveScope(delta, {mode: 'delta', destructive: 'post', sourceDirs: ['force-app']});
    assert.deepEqual(scope.args, [
      '--manifest', '.delta/package/package.xml',
      '--post-destructive-changes', '.delta/destructiveChanges/destructiveChanges.xml'
    ]);
  });

  it('deploys the directory whole for a full run, and carries no deletions', () => {
    // A full run has no delta to derive deletions from: it is a seed or a
    // resync, and deleting components a diff never mentioned is not part of it.
    const scope = resolveScope(delta, {mode: 'full', destructive: 'post', sourceDirs: ['force-app']});
    assert.deepEqual(scope.args, ['--source-dir', 'force-app']);
    assert.equal(scope.args.includes('--post-destructive-changes'), false);
  });

  it('names every package directory in a full run', () => {
    const scope = resolveScope(delta, {mode: 'full', destructive: 'post', sourceDirs: ['force-app', 'malyavi-app']});
    assert.deepEqual(scope.args, ['--source-dir', 'force-app', '--source-dir', 'malyavi-app']);
    assert.match(scope.label, /`force-app\/` and `malyavi-app\/`/);
  });
});

describe('isEmpty', () => {
  it('is true only when neither manifest holds anything', () => {
    assert.equal(isEmpty({package: {isEmpty: true}, destructive: {isEmpty: true}}), true);
    assert.equal(isEmpty({package: {isEmpty: true}, destructive: {isEmpty: false}}), false);
  });
});

describe('verb', () => {
  it('calls a check-only run a validation, since calling it a deployment misleads', () => {
    assert.equal(verb({checkOnly: true}), 'Validation');
    assert.equal(verb({checkOnly: false}), 'Deployment');
  });
});

describe('the summaries', () => {
  const config = {
    environment: 'production',
    testLevel: 'RunLocalTests',
    sourceDirs: ['force-app'],
    checkOnly: false,
    extraDirs: []
  };
  const anchored = {anchored: true, tag: 'ci/deployed/production', sha: 'a'.repeat(40)};

  it('say where the anchor ended up', () => {
    const summary = summarySucceeded(config, {label: 'the delta'}, anchored);
    assert.match(summary, /^## :white_check_mark: Deployment succeeded \(production\)/);
    assert.match(summary, /`ci\/deployed\/production` now points at `aaaaaaa`/);
  });

  it('say plainly that a check-only run saved nothing', () => {
    const summary = summarySucceeded({...config, checkOnly: true}, {label: 'the delta'}, {anchored: false});
    assert.match(summary, /Validation succeeded/);
    assert.match(summary, /nothing was saved to the org/);
  });

  it('explain why the anchor moves for a run with nothing to deploy', () => {
    const summary = summaryNothing(
      config,
      {baseSha: 'b'.repeat(40), baseSource: 'the last deployment (ci/deployed/production)'},
      anchored
    );
    assert.match(summary, /No metadata changes to deploy/);
    assert.match(summary, /the last deployment/);
    assert.match(summary, /the next delta starts from here/);
  });

  it('quote the tail of a failure, which is where the reason is', () => {
    const output = Array.from({length: 400}, (unused, index) => `line ${index}`).join('\n');
    const summary = summaryFailed(config, {label: 'the delta'}, output);
    assert.match(summary, /line 399/);
    assert.equal(summary.includes('line 50'), false);
  });

  it('say a full run is not a delta', () => {
    assert.match(summaryFull(config, 'abc1234'), /Every component under `force-app\/` at `abc1234`, not a delta/);
  });
});

describe('the pieces shared with the validation action', () => {
  it('normalizes a key and reads a deploy id', () => {
    assert.match(toPem(Buffer.from('-----BEGIN KEY-----\nx\n').toString('base64')), /BEGIN KEY/);
    assert.equal(deployIdFrom('Deploy ID: 0AfXX00000ABCDEFGH'), '0AfXX00000ABCDEFGH');
    assert.equal(versioned('sfdx-git-delta', 'latest'), 'sfdx-git-delta@latest');
  });
});
