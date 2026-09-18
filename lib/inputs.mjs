/**
 * Reads the action's inputs.
 *
 * A composite action does not populate `INPUT_*` for its `run:` steps the way a
 * JavaScript action does, so every `action.yml` here maps its inputs into that
 * namespace explicitly. Reading them through one module keeps the naming
 * convention — GitHub's own: upper-cased, spaces and dashes to underscores — in
 * a single place, and makes a script runnable by hand with a set environment.
 */

/**
 * A misconfiguration of the action, as distinct from a failure of the thing
 * being checked. Reported as its message alone, with no stack trace, because
 * the message is the whole of what the caller can act on.
 */
export class ConfigError extends Error {
  /**
   * @param {string} message What is wrong and what to set instead
   */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * The environment variable an input arrives in.
 *
 * @param {string} name Input name as `action.yml` spells it
 * @return {string} Environment variable name
 */
export function envName(name) {
  return `INPUT_${name.replace(/[ -]/g, '_').toUpperCase()}`;
}

/**
 * One input, trimmed, with a fallback for an absent or empty value.
 *
 * Empty is treated as absent on purpose: an unset `${{ vars.X }}` or a
 * conditional expression arrives as the empty string, and a caller who leaves
 * an input out means "use the default" rather than "use nothing".
 *
 * @param {string} name Input name
 * @param {string} [fallback] Value to use when the input is absent or empty
 * @return {string} The input value
 */
export function input(name, fallback = '') {
  const value = process.env[envName(name)];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

/**
 * One input with its whitespace intact, for a value whose shape matters — a PEM
 * key, a body of text, an argument string.
 *
 * @param {string} name Input name
 * @param {string} [fallback] Value to use when the input is absent or empty
 * @return {string} The input value
 */
export function rawInput(name, fallback = '') {
  const value = process.env[envName(name)];
  return value === undefined || value.trim() === '' ? fallback : value;
}

/**
 * One input that must be set.
 *
 * @param {string} name Input name
 * @param {string} [hint] What to set it to, appended to the refusal
 * @return {string} The input value
 * @throws {ConfigError} When the input is absent or empty
 */
export function requireInput(name, hint = '') {
  const value = rawInput(name);
  if (!value) {
    throw new ConfigError(`The \`${name}\` input is required.${hint ? ` ${hint}` : ''}`);
  }
  return value;
}

/**
 * One boolean input. Anything but a recognised true or false value is a
 * misconfiguration rather than a silent false, because a typo in a workflow
 * would otherwise turn a check off without saying so.
 *
 * @param {string} name Input name
 * @param {boolean} [fallback] Value to use when the input is absent or empty
 * @return {boolean} The input value
 * @throws {ConfigError} When the value is neither true nor false
 */
export function booleanInput(name, fallback = false) {
  const value = input(name).toLowerCase();
  if (!value) {
    return fallback;
  }
  if (['true', 'yes', '1', 'on'].includes(value)) {
    return true;
  }
  if (['false', 'no', '0', 'off'].includes(value)) {
    return false;
  }
  throw new ConfigError(`The \`${name}\` input must be true or false, not "${value}".`);
}

/**
 * One integer input.
 *
 * @param {string} name Input name
 * @param {number} fallback Value to use when the input is absent or empty
 * @return {number} The input value
 * @throws {ConfigError} When the value is not a positive integer
 */
export function intInput(name, fallback) {
  const value = input(name);
  if (!value) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`The \`${name}\` input must be a whole number, not "${value}".`);
  }
  return Number(value);
}

/**
 * One list input, written as a comma-separated or newline-separated string.
 *
 * Both separators are accepted because a YAML block scalar is the readable way
 * to pass a long list and a comma the readable way to pass a short one.
 *
 * @param {string} name Input name
 * @param {string[]} [fallback] Value to use when the input is absent or empty
 * @return {string[]} The list, with empty entries dropped
 */
export function listInput(name, fallback = []) {
  const value = input(name);
  if (!value) {
    return fallback;
  }
  return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * One input holding a shell-style argument string, split on whitespace outside
 * quotes so an argument carrying a space survives.
 *
 * @param {string} name Input name
 * @param {string[]} [fallback] Value to use when the input is absent or empty
 * @return {string[]} The arguments
 */
export function argsInput(name, fallback = []) {
  const value = rawInput(name);
  if (!value.trim()) {
    return fallback;
  }
  const args = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return args.map((arg) => arg.replace(/^(['"])([\s\S]*)\1$/, '$2'));
}

/**
 * Reports the failure of a script the way the caller can act on it: a
 * misconfiguration or a failed command says its message alone, and anything
 * else is a bug in the action and earns a stack trace.
 *
 * @param {unknown} thrown What was thrown
 * @return {string} The message to annotate
 */
export function failureMessage(thrown) {
  const expected = thrown instanceof ConfigError || thrown?.exitCode !== undefined;
  return expected ? thrown.message : (thrown?.stack ?? String(thrown));
}
