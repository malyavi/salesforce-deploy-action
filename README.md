# salesforce-deploy-action

Deploys changed Salesforce metadata to an org, and records what reached it — so
the next deployment diffs from what is **live** rather than from what was
pushed.

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0

- uses: malyavi/salesforce-deploy-action@v1
  with:
    jwt-key: ${{ secrets.SF_JWT_KEY }}
    username: ${{ vars.SF_USERNAME }}
    client-id: ${{ vars.SF_CLIENT_ID }}
    instance-url: ${{ vars.SF_INSTANCE_URL }}
    before-sha: ${{ github.event.before }}
```

The job needs `contents: write`, because a successful run moves a tag.

## The anchor tag, which is the point of this action

A delta deployment needs a commit to diff from, and the obvious candidate — the
previous commit on the branch — answers the wrong question. `github.event.before`
says what was **pushed**. What matters is what was **deployed**, and the two
diverge the moment a run fails, is cancelled, or is filtered out by a workflow's
`paths:`. From then on, every later delta silently omits the components that
never made it: the org falls behind the source, and nothing in any log says so.

So a successful run moves a tag — `ci/deployed/<environment>` by default — to the
commit it deployed, and the next run diffs from there. A tag moved only on
success cannot drift that way.

Three details follow from that:

- **A check-only run never moves it.** Nothing reached the org, so the tag would
  be claiming a deployment that did not happen, and the next real delta would
  start too late.
- **A run with nothing to deploy moves it anyway.** The org already matches the
  commit, so leaving the tag behind would make every later delta re-diff from a
  commit applied long ago — and grow for as long as nobody notices.
- **A tag the target does not descend from is ignored.** After a force-push or a
  branch reset it describes history that is no longer there, so the run falls
  back to `before-sha` and says so in the log.

## What a run does

1. Installs the Salesforce CLI and sfdx-git-delta.
2. Resolves the base: `base-sha`, else the anchor tag, else `before-sha`, else
   the commit's first parent.
3. Builds the delta — and **finishes green without logging in** when nothing
   deployable changed, moving the anchor forward.
4. Authenticates, prunes the deletions the org has already applied, and deploys.
5. Moves the anchor and writes the job summary.

`mode: full` skips the delta and deploys the whole source directory. That is the
bootstrap — a delta only carries what changed, so an org that has never received
the full tree fails on components no diff ever touches — and the way back after
an org has drifted. A full run carries **no** deletions, because it has no diff
to derive them from.

## Inputs

### The credential

Either the JWT bearer flow or an sfdx auth URL. An incomplete one is refused by
name, before anything is installed.

| Input | Default | What it does |
| --- | --- | --- |
| `jwt-key` | — | Private key, as PEM or base64-encoded PEM. |
| `username` | — | Username to authenticate as. |
| `client-id` | — | Consumer key of the connected app. |
| `instance-url` | `https://login.salesforce.com` | `https://test.salesforce.com` for a sandbox. |
| `auth-url` | — | An sfdx auth URL instead of the three above. |
| `org-alias` | `deploy-target` | Alias for the duration of the run; also names the key file. |

### What to deploy

| Input | Default | What it does |
| --- | --- | --- |
| `mode` | `delta` | `full` deploys the whole source directory. |
| `check-only` | `false` | Runs the same deployment and tests and saves nothing. |
| `source-dirs` | `force-app` | The package directories to deploy. Several get one flag each, so a repository with more than one produces a single delta whose manifest resolves a component in either. |
| `base-sha` | the anchor tag | Overrides the base entirely. |
| `before-sha` | — | The push event's own `before`, used when there is no anchor yet. |
| `head-sha` | `github.sha` | The commit to deploy. |
| `ignore-whitespace` | `true` | Whether a whitespace-only change counts. |
| `destructive-changes` | `post` | `post`, `pre` or `ignore`. |
| `prune-destructive` | `true` | Drop deletions the org has already applied. |
| `test-level` | `RunLocalTests` | Production accepts nothing less; a sandbox may take `NoTestRun`. |
| `tests` | — | Classes for `RunSpecifiedTests`. |
| `wait-minutes` | `30` | How long to wait for the org. |
| `api-version` | from `sfdx-project.json` | Only used when rewriting a pruned manifest. |

### The anchor and the run

| Input | Default | What it does |
| --- | --- | --- |
| `move-anchor` | `true` | Off for a deployment that is not this environment's own history. |
| `tag-prefix` | `ci/deployed` | The environment is appended to it. |
| `anchor-tag` | — | The full tag name, when prefix and environment do not compose it. |
| `environment` | the branch | Names the anchor tag and appears in the summaries. |
| `install-toolchain` | `true` | Off for a repository that pins the CLI itself. |
| `sf-cli-version`, `sgd-version` | `latest` | Versions to install. |
| `logout` | `true` | Revoke the session and delete the key when the run ends. |
| `label` | `Deployment` | How the run names itself. |
| `working-directory` | `.` | Directory holding the project. |
| `github-token` | `github.token` | Reads the history and moves the tag. |

## Outputs

| Output | What it holds |
| --- | --- |
| `outcome` | `passed`, `failed` or `skipped`. |
| `deploy-id` | The deployment's job id. |
| `deployed-sha` | The commit the anchor now records — empty when it did not move. |
| `anchor-tag` | The tag this run used. |
| `components`, `deletions`, `base-sha` | The size and origin of the delta. |
| `manifest-path`, `destructive-path` | The generated manifests. |

The delta outputs are published **before** the org is touched, so a later step
can upload the manifests even when the deployment failed.

## Pruning deletions

`destructiveChanges.xml` comes from the git diff alone, so it lists everything
the branch removed whether or not the component is still in the org — and
deleting one that is not there is a hard error. Removing a custom object takes
its layouts with it, so a later commit tidying up the orphaned layout files
describes a deletion the org performed months ago.

The check **fails open**: a type that cannot be listed keeps all of its members,
so a spurious listing failure behaves like no pruning rather than silently
skipping a deletion that was genuinely required.

## Concurrency

Serialize per environment and let runs queue rather than cancelling them
mid-deployment: killing the runner leaves CloudFormation's Salesforce equivalent
— the deployment itself — still rolling forward with nobody watching.

```yaml
concurrency:
  group: deploy-${{ github.ref_name }}
  cancel-in-progress: false
```

A cancelled job still cancels the org-side deployment: the job id is read out of
the CLI's output as it appears and saved to the job environment, so the cleanup
step can cancel it even when the process that started it is gone.

## Requirements

- **`fetch-depth: 0`** on the checkout; the delta reads history.
- **`contents: write`** to move the anchor tag.
- **Node 20 or newer**, which every GitHub-hosted runner has.

## Development

```bash
npm test                           # unit suite, no dependencies
python3 test/check-action-yaml.py  # action.yml parses and maps every input
test/fixtures/setup.sh /tmp/fix    # a three-branch repository to run against
```

The smoke job runs the action four times against that fixture — no credential,
an empty delta, a real delta, and a check-only run — and asserts that the last
one left the anchor alone. No org and no tag is involved; what happens inside a
deployment is Salesforce's own behaviour.
