import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ScnError } from './errors.ts';
import { git, GitError, gitText } from './git.ts';

/** Files larger than this come back as an error from `read`. */
const maxReadBytes = 10 * 1024 * 1024;
/** A patch longer than this is cut, and `truncated` is set. */
const maxPatchBytes = 2 * 1024 * 1024;
const fileModes = ['100644', '100755', '120000'] as const;

export type FileMode = (typeof fileModes)[number];

export type TreeEntry = { mode: string; type: string; oid: string; path: string };

export type FileContent = { encoding: 'utf8' | 'base64'; content: string };

export type ReadResult =
  | ({ kind: 'file'; commit: string; path: string; mode: string; size: number } & FileContent)
  | {
      kind: 'dir';
      commit: string;
      path: string;
      entries: Array<{ name: string; type: string; mode: string }>;
    };

export type LogEntry = {
  commit: string;
  parents: Array<string>;
  author: { name: string; email: string; date: string };
  committedAt: string;
  subject: string;
  body: string;
};

export type BlameLine = {
  line: number;
  commit: string;
  originalLine: number;
  author: string;
  authorEmail: string;
  authorTime: string;
  summary: string;
  text: string;
};

export type ChangedFile = { status: string; path: string; oldPath?: string };

export type DiffResult = {
  from: string;
  to: string;
  files: Array<ChangedFile>;
  patch: string;
  truncated: boolean;
};

export type Edit =
  | { path: string; content: string; encoding?: 'utf8' | 'base64'; mode?: FileMode }
  | { path: string; delete: true };

export type Person = { name: string; email: string };

export type CommitRequest = {
  /** The commit to build on: a sha, a branch or a change ref. */
  base: string;
  message: string;
  edits: Array<Edit>;
  /** Moves this change ref to the new commit. A new id is made when it is absent. */
  change?: string;
  author?: Person;
};

export type CommitResult = {
  change: string;
  commit: string;
  base: string;
  tree: string;
  files: Array<ChangedFile>;
};

const defaultAuthor: Person = { name: 'scn agent', email: 'agent@scn.local' };
const committer: Person = { name: 'scn-lite', email: 'scn@scn.local' };

/**
 * A repo path in canonical form: no leading "./", no trailing "/", no ".." and
 * no ".git" segment. An empty string is the root.
 */
export function normalizePath(input: string, allowRoot: boolean): string {
  if (input.includes('\0')) {
    throw new ScnError('bad_request', 'A path cannot hold a NUL byte.');
  }
  const trimmed = input.replace(/^(\.\/)+/u, '').replace(/\/+$/u, '');
  if (trimmed === '' || trimmed === '.') {
    if (allowRoot) {
      return '';
    }
    throw new ScnError('bad_request', 'A path is required.');
  }
  if (trimmed.startsWith('/')) {
    throw new ScnError('bad_request', `"${input}" is absolute. Use a path from the repo root.`);
  }
  for (const part of trimmed.split('/')) {
    if (part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git') {
      throw new ScnError('bad_request', `"${input}" is not a valid repo path.`);
    }
  }
  return trimmed;
}

function checkRev(rev: string): void {
  if (rev === '' || rev.startsWith('-') || /[\s\0]/u.test(rev)) {
    throw new ScnError('bad_request', `"${rev}" is not a valid revision.`);
  }
}

function checkPerson(person: Person): void {
  for (const value of [person.name, person.email]) {
    if (value.trim() === '' || /[<>\n\0]/u.test(value)) {
      throw new ScnError(
        'bad_request',
        'An author needs a name and an email with no <, > or newline.',
      );
    }
  }
}

export function checkChangeId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id) || id.endsWith('.lock') || id.includes('..')) {
    throw new ScnError(
      'bad_request',
      `"${id}" is not a valid change id. Use letters, digits, ".", "_" and "-".`,
    );
  }
}

export function newChangeId(): string {
  return `ch-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Text when the bytes are valid UTF-8 with no NUL byte, else base64. */
export function encodeContent(bytes: Uint8Array): FileContent {
  if (!bytes.subarray(0, 8000).includes(0)) {
    try {
      return { encoding: 'utf8', content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      // Not UTF-8. Send base64.
    }
  }
  return { encoding: 'base64', content: Buffer.from(bytes).toString('base64') };
}

function parseTree(stdout: string): Array<TreeEntry> {
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t');
      const [mode = '', type = '', oid = ''] = record.slice(0, tab).split(' ');
      return { mode, type, oid, path: record.slice(tab + 1) };
    });
}

function parseNameStatus(stdout: string): Array<ChangedFile> {
  const tokens = stdout.split('\0');
  const files: Array<ChangedFile> = [];
  for (let i = 0; i < tokens.length && tokens[i] !== '';) {
    const status = tokens[i++] ?? '';
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ status, oldPath: tokens[i++] ?? '', path: tokens[i++] ?? '' });
    } else {
      files.push({ status, path: tokens[i++] ?? '' });
    }
  }
  return files;
}

/** The plumbing operations on one bare repo. */
export class Repo {
  constructor(
    readonly name: string,
    readonly gitDir: string,
  ) {}

  /** The full commit id for a revision. */
  async resolve(rev: string): Promise<string> {
    checkRev(rev);
    const { stdout, exitCode } = await git(
      this.gitDir,
      ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`],
      { allowExit: [1] },
    );
    if (exitCode !== 0) {
      throw new ScnError('not_found', `No commit matches "${rev}".`);
    }
    return new TextDecoder().decode(stdout).trim();
  }

  private async entry(commit: string, repoPath: string): Promise<TreeEntry | undefined> {
    const out = await gitText(this.gitDir, ['ls-tree', '-z', commit, '--', repoPath]);
    return parseTree(out).find((entry) => entry.path === repoPath);
  }

  async read(rev: string, filePath = ''): Promise<ReadResult> {
    const commit = await this.resolve(rev);
    const repoPath = normalizePath(filePath, true);
    const entry =
      repoPath === ''
        ? { mode: '040000', type: 'tree', oid: `${commit}^{tree}`, path: '' }
        : await this.entry(commit, repoPath);
    if (!entry) {
      throw new ScnError('not_found', `"${repoPath}" does not exist at ${commit.slice(0, 12)}.`);
    }
    if (entry.type === 'tree') {
      const out = await gitText(this.gitDir, ['ls-tree', '-z', entry.oid]);
      const entries = parseTree(out).map((child) => ({
        name: child.path,
        type: child.type,
        mode: child.mode,
      }));
      return { kind: 'dir', commit, path: repoPath, entries };
    }
    if (entry.type !== 'blob') {
      throw new ScnError('bad_request', `"${repoPath}" is a ${entry.type}, not a file.`);
    }
    const size = Number((await gitText(this.gitDir, ['cat-file', '-s', entry.oid])).trim());
    if (size > maxReadBytes) {
      throw new ScnError(
        'bad_request',
        `"${repoPath}" is ${size} bytes. The limit is ${maxReadBytes}.`,
      );
    }
    const { stdout } = await git(this.gitDir, ['cat-file', 'blob', entry.oid]);
    return {
      kind: 'file',
      commit,
      path: repoPath,
      mode: entry.mode,
      size,
      ...encodeContent(stdout),
    };
  }

  async log(options: { rev?: string; path?: string; limit?: number; skip?: number } = {}) {
    const commit = await this.resolve(options.rev ?? 'HEAD');
    const limit = options.limit ?? 20;
    const skip = options.skip ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ScnError('bad_request', 'limit must be a whole number from 1 to 500.');
    }
    if (!Number.isInteger(skip) || skip < 0) {
      throw new ScnError('bad_request', 'skip must be a whole number of 0 or more.');
    }
    const paths = options.path === undefined ? [] : [normalizePath(options.path, false)];
    const out = await gitText(this.gitDir, [
      'log',
      '-z',
      '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1f%b',
      `--max-count=${limit}`,
      `--skip=${skip}`,
      commit,
      '--',
      ...paths,
    ]);
    return out
      .split('\0')
      .filter(Boolean)
      .map((record): LogEntry => {
        const [
          sha = '',
          parents = '',
          name = '',
          email = '',
          date = '',
          committedAt = '',
          subject = '',
          body = '',
        ] = record.split('\x1f');
        return {
          commit: sha,
          parents: parents.split(' ').filter(Boolean),
          author: { name, email, date },
          committedAt,
          subject,
          body: body.trim(),
        };
      });
  }

  async blame(rev: string, filePath: string, range?: { start: number; end?: number }) {
    const commit = await this.resolve(rev);
    const repoPath = normalizePath(filePath, false);
    const entry = await this.entry(commit, repoPath);
    if (!entry || entry.type !== 'blob') {
      throw new ScnError('not_found', `"${repoPath}" is not a file at ${commit.slice(0, 12)}.`);
    }
    const lines: Array<string> = [];
    if (range) {
      const { start, end } = range;
      if (
        !Number.isInteger(start) ||
        start < 1 ||
        (end !== undefined && (!Number.isInteger(end) || end < start))
      ) {
        throw new ScnError('bad_request', 'A blame range needs start >= 1 and end >= start.');
      }
      lines.push('-L', `${start},${end ?? ''}`);
    }
    const out = await gitText(this.gitDir, [
      'blame',
      '--line-porcelain',
      ...lines,
      commit,
      '--',
      repoPath,
    ]);
    const result: Array<BlameLine> = [];
    let current: Partial<BlameLine> = {};
    for (const line of out.split('\n')) {
      const header = /^([0-9a-f]{40,64}) (\d+) (\d+)/u.exec(line);
      if (header) {
        current = { commit: header[1], originalLine: Number(header[2]), line: Number(header[3]) };
      } else if (line.startsWith('\t')) {
        result.push({ ...(current as BlameLine), text: line.slice(1) });
      } else if (line.startsWith('author ')) {
        current.author = line.slice(7);
      } else if (line.startsWith('author-mail ')) {
        current.authorEmail = line.slice(12).replace(/^<|>$/gu, '');
      } else if (line.startsWith('author-time ')) {
        current.authorTime = new Date(Number(line.slice(12)) * 1000).toISOString();
      } else if (line.startsWith('summary ')) {
        current.summary = line.slice(8);
      }
    }
    return result;
  }

  async diff(from: string, to: string, filePaths: Array<string> = []): Promise<DiffResult> {
    const [fromSha, toSha] = await Promise.all([this.resolve(from), this.resolve(to)]);
    const paths = filePaths.map((p) => normalizePath(p, false));
    const [names, patch] = await Promise.all([
      gitText(this.gitDir, ['diff', '-z', '--name-status', '-M', fromSha, toSha, '--', ...paths]),
      gitText(this.gitDir, [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '-M',
        fromSha,
        toSha,
        '--',
        ...paths,
      ]),
    ]);
    const truncated = patch.length > maxPatchBytes;
    return {
      from: fromSha,
      to: toSha,
      files: parseNameStatus(names),
      patch: truncated ? patch.slice(0, maxPatchBytes) : patch,
      truncated,
    };
  }

  /**
   * Builds one commit on `base` from whole-file edits, with a private index, and
   * moves `refs/scn/changes/<change>` to it. No work tree is touched.
   */
  async commit(request: CommitRequest): Promise<CommitResult> {
    const message = request.message.trim();
    if (message === '') {
      throw new ScnError('bad_request', 'A commit needs a message.');
    }
    if (request.edits.length === 0) {
      throw new ScnError('bad_request', 'A commit needs at least one edit.');
    }
    const author = request.author ?? defaultAuthor;
    checkPerson(author);
    const change = request.change ?? newChangeId();
    checkChangeId(change);
    const edits = request.edits.map((edit) => ({ ...edit, path: normalizePath(edit.path, false) }));
    const seen = new Set<string>();
    for (const edit of edits) {
      if (seen.has(edit.path)) {
        throw new ScnError('bad_request', `"${edit.path}" has more than one edit.`);
      }
      seen.add(edit.path);
    }

    const base = await this.resolve(request.base);
    const ref = `refs/scn/changes/${change}`;
    const previous = (
      await gitText(this.gitDir, ['rev-parse', '--verify', '--quiet', ref], { allowExit: [1] })
    ).trim();

    const indexFile = path.join(tmpdir(), `scn-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await git(this.gitDir, ['read-tree', base], { env });
      for (const edit of edits) {
        const existing = await this.entry(base, edit.path);
        if (existing?.type === 'tree') {
          throw new ScnError(
            'conflict',
            `"${edit.path}" is a directory. Edit the files inside it.`,
          );
        }
        if ('delete' in edit) {
          if (!existing) {
            throw new ScnError(
              'not_found',
              `"${edit.path}" does not exist, so it cannot be deleted.`,
            );
          }
          // Mode 0 removes the entry. --force-remove needs a work tree, and this repo has none.
          await git(this.gitDir, ['update-index', '--index-info'], {
            env,
            input: `0 ${'0'.repeat(base.length)}\t${edit.path}\n`,
          });
          continue;
        }
        const mode =
          edit.mode ??
          (fileModes as ReadonlyArray<string>).find((m) => m === existing?.mode) ??
          '100644';
        if (!(fileModes as ReadonlyArray<string>).includes(mode)) {
          throw new ScnError('bad_request', `Mode ${mode} is not one of ${fileModes.join(', ')}.`);
        }
        const bytes =
          edit.encoding === 'base64'
            ? Buffer.from(edit.content, 'base64')
            : new TextEncoder().encode(edit.content);
        const oid = (
          await gitText(this.gitDir, ['hash-object', '-w', '--no-filters', '--stdin'], {
            input: bytes,
          })
        ).trim();
        try {
          await git(
            this.gitDir,
            ['update-index', '--add', '--cacheinfo', `${mode},${oid},${edit.path}`],
            { env },
          );
        } catch (error) {
          if (error instanceof GitError) {
            throw new ScnError(
              'conflict',
              `"${edit.path}" clashes with a file or directory: ${error.stderr.trim()}`,
            );
          }
          throw error;
        }
      }
      const tree = (await gitText(this.gitDir, ['write-tree'], { env })).trim();
      const baseTree = (await gitText(this.gitDir, ['rev-parse', `${base}^{tree}`])).trim();
      if (tree === baseTree) {
        throw new ScnError('empty', 'The edits do not change any file.');
      }
      const commit = (
        await gitText(this.gitDir, ['commit-tree', tree, '-p', base, '-F', '-'], {
          input: `${message}\n`,
          env: {
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: committer.name,
            GIT_COMMITTER_EMAIL: committer.email,
          },
        })
      ).trim();
      try {
        await git(this.gitDir, ['update-ref', '-m', 'scn commit', ref, commit, previous]);
      } catch (error) {
        if (error instanceof GitError) {
          throw new ScnError(
            'conflict',
            `Change ${change} moved while this commit was built. Read it and try again.`,
          );
        }
        throw error;
      }
      const files = parseNameStatus(
        await gitText(this.gitDir, ['diff-tree', '-z', '-r', '--name-status', '-M', base, commit]),
      );
      return { change, commit, base, tree, files };
    } finally {
      await rm(indexFile, { force: true });
      await rm(`${indexFile}.lock`, { force: true });
    }
  }
}
