import {spawn} from 'node:child_process';

/**
 * Spawns a command, streaming its output to the job log while also collecting
 * it so callers can put a failure in the step summary.
 *
 * Rejects with an Error carrying `exitCode` and `output` on a non-zero exit.
 *
 * `capture` is for reading a command's `--json` output. Ordinarily the two
 * streams are merged, which is right for a job log but fatal to a parser: a CLI
 * that prints an update notice on stderr makes the merged text a warning line
 * followed by JSON, and `JSON.parse` rejects the whole thing.
 *
 * @param {string} command Executable or command name
 * @param {string[]} args Command-line arguments
 * @param {{ input?: string, echo?: boolean, capture?: boolean, cwd?: string, env?: Record<string, string>, onStdout?: (chunk: string, output: string) => void }} [options] Spawn options
 * @return {Promise<string>} Combined stdout and stderr, or stdout alone when `capture` is set
 */
export function run(command, args, options = {}) {
  const {input, echo = true, capture = false, cwd, env, onStdout} = options;

  return new Promise((resolve, reject) => {
    if (echo) {
      console.log(`$ ${command} ${args.join(' ')}`);
    }

    const child = spawn(command, args, {
      cwd,
      env: env ? {...process.env, ...env} : process.env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });

    let output = '';
    let stdout = '';
    for (const [source, sink] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ]) {
      source.setEncoding('utf8');
      source.on('data', (chunk) => {
        output += chunk;
        if (source === child.stdout) {
          stdout += chunk;
        }
        if (!capture) {
          sink.write(chunk);
        }
        if (source === child.stdout && onStdout) {
          try {
            onStdout(chunk, output);
          } catch {
            // A callback that throws must not take the command down with it.
          }
        }
      });
    }

    if (input !== undefined) {
      child.stdin.end(input);
    }

    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve(capture ? stdout : output);
        return;
      }
      const failure = new Error(`\`${command} ${args.join(' ')}\` exited with code ${exitCode}`);
      failure.exitCode = exitCode;
      failure.output = output;
      reject(failure);
    });
  });
}

/**
 * Runs a command written as one string — the shape an action input takes — by
 * splitting it into a program and its arguments.
 *
 * Split rather than handed to a shell: a shell would make every input a place
 * an injected `;` runs something, and nothing here needs a pipeline.
 *
 * @param {string} command The command line
 * @param {string[]} [extraArgs] Arguments appended after the command's own
 * @param {object} [options] Options for `run`
 * @return {Promise<string>} The command's output
 */
export function runCommandLine(command, extraArgs = [], options = {}) {
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const [program, ...args] = parts.map((part) => part.replace(/^(['"])([\s\S]*)\1$/, '$2'));
  return run(program, [...args, ...extraArgs], options);
}

/**
 * Lists the files a commit range changed under one or more pathspecs.
 *
 * Reads git rather than the GitHub API on purpose: a job that checks out full
 * history can answer this locally, and one local `git diff` cannot come back
 * empty for a reason unrelated to the diff — a missing token, a rate limit, a
 * job re-run that lost an earlier job's outputs.
 *
 * `relative` reports the paths relative to the working directory rather than to
 * the repository root, which is what a caller pointed at a subdirectory of a
 * monorepo needs: every other path it handles — an input, a file on disk — is
 * relative to that directory too.
 *
 * @param {string} from Base commit
 * @param {string} to Target commit
 * @param {string[]} [pathspecs] Paths to restrict the diff to
 * @param {{ cwd?: string, relative?: boolean }} [options] Options for `run`, plus `relative`
 * @return {Promise<string[]>} Changed paths, empty when nothing matched
 */
export async function changedPaths(from, to, pathspecs = [], options = {}) {
  const {relative = false, ...runOptions} = options;
  const args = ['diff', '--name-only'];
  if (relative) {
    args.push('--relative');
  }
  args.push(`${from}..${to}`);
  if (pathspecs.length > 0) {
    args.push('--', ...pathspecs);
  }
  const output = await run('git', args, {echo: false, ...runOptions});
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}
