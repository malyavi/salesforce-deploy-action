import {afterEach, describe, it} from 'node:test';
import assert                    from 'node:assert/strict';
import {
  argsInput,
  booleanInput,
  ConfigError,
  envName,
  failureMessage,
  input,
  intInput,
  listInput,
  rawInput,
  requireInput
}                                from '../lib/inputs.mjs';

/**
 * The input layer, which is the one piece of every action in this family that
 * a caller's mistake reaches first.
 */

const set = (name, value) => {
  process.env[envName(name)] = value;
};

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) {
      delete process.env[key];
    }
  }
});

describe('envName', () => {
  it('matches the convention GitHub uses for a JavaScript action', () => {
    assert.equal(envName('source-dirs'), 'INPUT_SOURCE_DIRS');
    assert.equal(envName('mode'), 'INPUT_MODE');
    assert.equal(envName('a name with spaces'), 'INPUT_A_NAME_WITH_SPACES');
  });
});

describe('input', () => {
  it('trims the value, because a YAML block scalar brings a newline with it', () => {
    set('mode', '  full\n');
    assert.equal(input('mode'), 'full');
  });

  it('treats an empty value as absent', () => {
    // An unset `${{ vars.X }}` arrives as the empty string, and a caller who
    // leaves an input out means "use the default" rather than "use nothing".
    set('mode', '');
    assert.equal(input('mode', 'auto'), 'auto');
  });

  it('keeps whitespace when the caller asks for the value raw', () => {
    set('key', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n');
    assert.match(rawInput('key'), /\n/);
  });
});

describe('requireInput', () => {
  it('refuses an absent input with a message naming it', () => {
    assert.throws(() => requireInput('username', 'Set it to the integration user.'), (thrown) => {
      assert.ok(thrown instanceof ConfigError);
      assert.match(thrown.message, /`username` input is required/);
      assert.match(thrown.message, /integration user/);
      return true;
    });
  });

  it('returns a value that is set', () => {
    set('username', 'ci@example.com');
    assert.equal(requireInput('username'), 'ci@example.com');
  });
});

describe('booleanInput', () => {
  it('accepts the spellings a workflow author actually writes', () => {
    for (const truthy of ['true', 'TRUE', 'yes', '1', 'on']) {
      set('flag', truthy);
      assert.equal(booleanInput('flag'), true, truthy);
    }
    for (const falsy of ['false', 'False', 'no', '0', 'off']) {
      set('flag', falsy);
      assert.equal(booleanInput('flag'), false, falsy);
    }
  });

  it('refuses a value that is neither, rather than reading it as false', () => {
    // A typo in a workflow would otherwise turn a check off without saying so.
    set('flag', 'ture');
    assert.throws(() => booleanInput('flag', true), ConfigError);
  });

  it('falls back when the input is absent', () => {
    assert.equal(booleanInput('flag', true), true);
  });
});

describe('intInput', () => {
  it('refuses anything but a whole number', () => {
    set('wait', '30m');
    assert.throws(() => intInput('wait', 30), ConfigError);
  });

  it('reads a number and falls back when absent', () => {
    set('wait', '45');
    assert.equal(intInput('wait', 30), 45);
    delete process.env[envName('wait')];
    assert.equal(intInput('wait', 30), 30);
  });
});

describe('listInput', () => {
  it('splits on commas and on newlines, so both YAML shapes work', () => {
    set('dirs', 'force-app, unpackaged-setup');
    assert.deepEqual(listInput('dirs'), ['force-app', 'unpackaged-setup']);
    set('dirs', 'force-app\nunpackaged-setup\n');
    assert.deepEqual(listInput('dirs'), ['force-app', 'unpackaged-setup']);
  });

  it('drops empty entries left by a trailing separator', () => {
    set('dirs', 'force-app,,');
    assert.deepEqual(listInput('dirs'), ['force-app']);
  });
});

describe('argsInput', () => {
  it('keeps a quoted argument together', () => {
    set('args', '--minimum-priority 3 --cache "/tmp/pmd cache"');
    assert.deepEqual(argsInput('args'), ['--minimum-priority', '3', '--cache', '/tmp/pmd cache']);
  });

  it('is empty rather than [""] for an absent value', () => {
    assert.deepEqual(argsInput('args'), []);
  });
});

describe('failureMessage', () => {
  it('says a misconfiguration plainly, with no stack trace', () => {
    assert.equal(failureMessage(new ConfigError('Set the thing.')), 'Set the thing.');
  });

  it('says a failed command plainly too, since its own output is the detail', () => {
    const thrown = new Error('`sf` exited with code 1');
    thrown.exitCode = 1;
    assert.equal(failureMessage(thrown), '`sf` exited with code 1');
  });

  it('shows a stack trace for anything else, because that is a bug in the action', () => {
    assert.match(failureMessage(new TypeError('x is not a function')), /TypeError/);
  });
});
