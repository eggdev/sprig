/** Runs git plumbing against one bare repo. Every call is a separate process. */

export class GitError extends Error {
  constructor(
    readonly args: ReadonlyArray<string>,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} exited ${exitCode}: ${stderr.trim()}`);
  }
}

export type GitOptions = {
  /** Extra environment, for example GIT_INDEX_FILE or author identity. */
  env?: Record<string, string>;
  /** Bytes for stdin. */
  input?: string | Uint8Array;
  /** Exit codes that are answers, not failures. */
  allowExit?: ReadonlyArray<number>;
};

export type GitResult = { stdout: Uint8Array; stderr: string; exitCode: number };

/** The parent environment without GIT_* variables, so a caller cannot redirect the repo. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_')) {
      env[key] = value;
    }
  }
  env.LC_ALL = 'C';
  env.GIT_TERMINAL_PROMPT = '0';
  // A path such as ":(glob)*" is a file name here, never pathspec magic.
  env.GIT_LITERAL_PATHSPECS = '1';
  return env;
}

/** Pass `gitDir` null for commands that make a repo, such as clone. */
export async function git(
  gitDir: string | null,
  args: ReadonlyArray<string>,
  options: GitOptions = {},
): Promise<GitResult> {
  const proc = Bun.spawn(['git', ...args], {
    env: { ...baseEnv(), ...(gitDir === null ? {} : { GIT_DIR: gitDir }), ...options.env },
    stdin: options.input === undefined ? 'ignore' : new Response(options.input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !options.allowExit?.includes(exitCode)) {
    throw new GitError(args, exitCode, stderr);
  }
  return { stdout, stderr, exitCode };
}

export async function gitText(
  gitDir: string | null,
  args: ReadonlyArray<string>,
  options: GitOptions = {},
): Promise<string> {
  return new TextDecoder().decode((await git(gitDir, args, options)).stdout);
}
