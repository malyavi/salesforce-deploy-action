import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join}                                from 'node:path';
import {describe, it}                        from 'node:test';
import assert                                from 'node:assert/strict';

/**
 * The wiring test.
 *
 * A composite action's inputs do not reach its `run:` steps on their own: each
 * one has to be mapped into the environment by hand. Forgetting a mapping is
 * the defect this repository is most likely to ship, because everything still
 * parses, the action still runs, and the input silently takes its default
 * instead of the caller's value. Nothing else notices — so this does.
 *
 * Read with a regular expression rather than a YAML parser on purpose: these
 * files are ours, their shape is fixed, and a test that adds a dependency to
 * the repository it is testing has to be installed before it can run.
 */

/** Functions in lib/inputs.mjs that name an input as their first argument. */
const READERS = /\b(?:input|rawInput|requireInput|booleanInput|intInput|listInput|argsInput)\(\s*'([a-z0-9-]+)'/g;

/** A direct read of the environment an input arrives in. */
const DIRECT = /process\.env\.(INPUT_[A-Z0-9_]+)/g;

const actionYml = readFileSync('action.yml', 'utf8');

describe('action.yml', () => {
  it('declares every input the code reads', () => {
    const declared = new Set(declaredInputs(actionYml));
    for (const name of readInputs()) {
      assert.ok(
        declared.has(name),
        `The code reads the \`${name}\` input, which action.yml does not declare. ` +
        'A caller cannot set it, so it is stuck on its default forever.'
      );
    }
  });

  it('maps every input the code reads into the run step environment', () => {
    const mapped = mappedInputs(actionYml);
    for (const name of readInputs()) {
      assert.equal(
        mapped.get(envName(name)),
        name,
        `The code reads the \`${name}\` input, but action.yml does not map it to ${envName(name)}. ` +
        'A composite action does not pass its inputs to a run step on its own, so the value never arrives.'
      );
    }
  });

  it('uses every input it declares', () => {
    const runs = actionYml.slice(actionYml.indexOf('\nruns:'));
    for (const name of declaredInputs(actionYml)) {
      assert.ok(
        runs.includes(`inputs.${name}`),
        `action.yml declares the \`${name}\` input and never reads it in its \`runs:\` block. ` +
        'Either wire it up or take it out — a documented input that does nothing is worse than none.'
      );
    }
  });

  it('points every output at a step that exists', () => {
    const ids = new Set([...actionYml.matchAll(/^\s+id:\s*([A-Za-z0-9_-]+)\s*$/gm)].map((match) => match[1]));
    const references = [...actionYml.matchAll(/value:\s*\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\./g)];
    assert.ok(references.length > 0, 'action.yml publishes no outputs at all.');
    for (const [, id] of references) {
      assert.ok(ids.has(id), `An output reads \`steps.${id}\`, which is not a step in this action.`);
    }
  });

  it('names its inputs and outputs in kebab-case', () => {
    for (const name of [...declaredInputs(actionYml), ...declaredOutputs(actionYml)]) {
      assert.match(
        name,
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
        `\`${name}\` is not kebab-case, which is the convention every other action follows.`
      );
    }
  });

  it('gives every input a description and a default, so none is silently required', () => {
    for (const block of inputBlocks(actionYml)) {
      assert.match(block.body, /description:/, `The \`${block.name}\` input has no description.`);
      if (!/required:\s*true/.test(block.body)) {
        assert.match(
          block.body,
          /default:/,
          `The \`${block.name}\` input is neither required nor defaulted, so leaving it out is undefined behaviour.`
        );
      }
    }
  });
});

/**
 * Input names the action's code reads, from both the helper calls and any
 * direct environment reads.
 *
 * @return {Set<string>} Input names in `action.yml` spelling
 */
function readInputs() {
  const names = new Set();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const [, name] of text.matchAll(READERS)) {
      names.add(name);
    }
    for (const [, variable] of text.matchAll(DIRECT)) {
      // GITHUB_TOKEN and the like are not inputs; only the INPUT_ namespace is.
      names.add(variable.replace(/^INPUT_/, '').toLowerCase().replace(/_/g, '-'));
    }
  }
  // The comment module reads these for every action that writes a comment; an
  // action that does not write one has no comment module to read them.
  return [...names];
}

/**
 * Every JavaScript file the action ships.
 *
 * @param {string} [dir] Directory to walk
 * @return {string[]} File paths
 */
function sourceFiles(dir = '.') {
  const roots = dir === '.' ? ['lib', 'scripts'] : [dir];
  const files = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(root, entry);
      if (statSync(path).isDirectory()) {
        files.push(...sourceFiles(path));
      } else if (path.endsWith('.mjs')) {
        files.push(path);
      }
    }
  }
  return files;
}

/**
 * The environment variable an input arrives in.
 *
 * @param {string} name Input name
 * @return {string} Environment variable name
 */
function envName(name) {
  return `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
}

/**
 * Input names declared by an action definition.
 *
 * @param {string} yml The file's text
 * @return {string[]} Declared input names
 */
function declaredInputs(yml) {
  return inputBlocks(yml).map((block) => block.name);
}

/**
 * Output names declared by an action definition.
 *
 * @param {string} yml The file's text
 * @return {string[]} Declared output names
 */
function declaredOutputs(yml) {
  return blocksOf(yml, 'outputs').map((block) => block.name);
}

/**
 * Each input's name and its own block of the file, for assertions about what a
 * declaration has to carry.
 *
 * @param {string} yml The file's text
 * @return {Array<{ name: string, body: string }>} One entry per input
 */
function inputBlocks(yml) {
  return blocksOf(yml, 'inputs');
}

/**
 * Splits a top-level mapping of an action definition into its entries.
 *
 * @param {string} yml The file's text
 * @param {string} section Top-level key to read
 * @return {Array<{ name: string, body: string }>} One entry per key of that section
 */
function blocksOf(yml, section) {
  const start = yml.indexOf(`\n${section}:`);
  if (start === -1) {
    return [];
  }
  const rest = yml.slice(start + section.length + 2);
  const end = rest.search(/\n[a-z]+:/);
  const body = end === -1 ? rest : rest.slice(0, end);

  const entries = [];
  const pattern = /^ {2}([a-z0-9-]+):\s*$/gm;
  const matches = [...body.matchAll(pattern)];
  for (const [index, match] of matches.entries()) {
    const from = match.index + match[0].length;
    const to = index + 1 < matches.length ? matches[index + 1].index : body.length;
    entries.push({name: match[1], body: body.slice(from, to)});
  }
  return entries;
}

/**
 * The `INPUT_*` environment mappings in the action's run steps.
 *
 * @param {string} yml The file's text
 * @return {Map<string, string>} Environment variable to the input it carries
 */
function mappedInputs(yml) {
  const mapped = new Map();
  for (const [, variable, name] of yml.matchAll(/(INPUT_[A-Z0-9_]+):\s*\$\{\{\s*inputs\.([a-z0-9-]+)\s*\}\}/g)) {
    mapped.set(variable, name);
  }
  return mapped;
}
