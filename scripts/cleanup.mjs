import {tmpdir}   from 'node:os';
import {join}     from 'node:path';
import {input}    from '../lib/inputs.mjs';
import {teardown} from '../lib/salesforce.mjs';

/**
 * Belt-and-braces cleanup, run from a step with `if: always()`.
 *
 * The deploy script tears down in its own `finally`, which covers every way it
 * can end on its own. This covers the ways it cannot: a cancelled job, a step
 * timeout, a runner that went away. In those cases the private key is still on
 * disk, the org session is still live, and — worst of the three — a deployment
 * may still be running in the org, holding the deployment lock against every
 * run behind it.
 *
 * Never fails: it runs after the verdict has already been decided.
 */
const orgAlias = input('org-alias', 'deploy-target');

await teardown({
  orgAlias,
  keyPath: join(process.env.RUNNER_TEMP || tmpdir(), `sf-auth-${orgAlias}.key`)
});
