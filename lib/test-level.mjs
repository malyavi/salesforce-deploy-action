/**
 * Deciding which Apex tests a run actually has to execute.
 *
 * A change made only of markup — a Lightning web component, an Aura bundle, a
 * Visualforce page or component, an email template — is HTML, CSS and
 * JavaScript. No Apex test can reach any of it: a test runs Apex, and none of
 * these types is Apex or is compiled into Apex. Running the org's local tests
 * over such a change costs the full suite and can only ever report something
 * the change did not cause. So a delta made of nothing else goes to the org
 * with `NoTestRun`, whatever the caller asked for, and the run says so. An
 * org accepts that for a package carrying no Apex, production included.
 *
 * The bar is *nothing else*: one Apex class, one field, one flow anywhere in
 * the delta — added, modified or deleted — and the configured level stands.
 * So does a run whose package is more than the delta lists: one that folded
 * an extra directory in, or one with no delta at all, whose manifest names no
 * types to look at.
 *
 * Both actions in this family ship this file unchanged: a validation and the
 * deployment that promotes it have to agree about which tests a change needs.
 */

/**
 * Metadata types that are markup and script alone. Nothing here can change
 * what an Apex test observes.
 */
export const UI_ONLY_TYPES = [
  'ApexComponent',
  'ApexPage',
  'AuraDefinitionBundle',
  'EmailTemplate',
  'LightningComponentBundle'
];

/**
 * Whether a delta touches UI metadata and nothing else.
 *
 * @param {object} delta The delta description
 * @return {boolean} True when every component in the delta is one of `UI_ONLY_TYPES`
 */
export function isUiOnly(delta) {
  if (delta?.extraChanged) {
    return false;
  }
  const types = typesIn(delta);
  return types.length > 0 && types.every((name) => UI_ONLY_TYPES.includes(name));
}

/**
 * The test level a run goes to the org with, and why, when it is not the one
 * asked for.
 *
 * @param {object} delta The delta description
 * @param {{ testLevel: string, tests: string[] }} config Resolved configuration
 * @return {{ testLevel: string, tests: string[], skipped: boolean, reason: string }} What to hand the CLI; `reason` is empty unless the tests were skipped
 */
export function resolveTestLevel(delta, config) {
  if (config.testLevel === 'NoTestRun' || !isUiOnly(delta)) {
    return {testLevel: config.testLevel, tests: config.tests, skipped: false, reason: ''};
  }

  const types = [...new Set(typesIn(delta))].sort();
  return {
    testLevel: 'NoTestRun',
    tests: [],
    skipped: true,
    reason:
      `Apex tests skipped: every change here is UI metadata (${types.map((name) => `\`${name}\``).join(', ')}), ` +
      `which no Apex test can reach. \`${config.testLevel}\` was asked for.`
  };
}

/**
 * The type names a delta lists, across its additions and its deletions.
 *
 * @param {object} delta The delta description
 * @return {string[]} Type names, with repeats
 */
function typesIn(delta) {
  return [delta?.package, delta?.destructive].flatMap((manifest) => (manifest?.types ?? []).map((type) => type.name));
}
