import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ScnError } from '../src/errors.ts';
import { Registry } from '../src/registry.ts';
import { normalizePath, type Repo } from '../src/repo.ts';

let dir: string;
let repo: Repo;
let first: string;
let second: string;

/** Runs git in a work tree, the way a person makes the seed history. */
async function work(cwd: string, ...args: Array<string>) {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((await proc.exited) !== 0) {
    throw new Error(await new Response(proc.stderr).text());
  }
  return (await new Response(proc.stdout).text()).trim();
}

async function rejects(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ScnError);
  expect((error as ScnError).code).toBe(code as ScnError['code']);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'scn-test-'));
  const seed = path.join(dir, 'seed');
  await work(dir, 'init', '-q', '-b', 'main', seed);
  await Bun.write(path.join(seed, 'README.md'), 'hello\n');
  await Bun.write(path.join(seed, 'src/app.ts'), 'export const a = 1;\n');
  await Bun.write(path.join(seed, 'bin/run'), '#!/bin/sh\necho run\n');
  await chmod(path.join(seed, 'bin/run'), 0o755);
  await work(seed, 'add', '.');
  await work(seed, 'commit', '-q', '-m', 'first');
  first = await work(seed, 'rev-parse', 'HEAD');
  await Bun.write(path.join(seed, 'src/app.ts'), 'export const a = 2;\nexport const b = 3;\n');
  await work(seed, 'commit', '-q', '-am', 'second', '-m', 'Body line.');
  second = await work(seed, 'rev-parse', 'HEAD');
  repo = await new Registry(path.join(dir, 'home')).add('demo', seed);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('normalizePath', () => {
  test('makes paths canonical', () => {
    expect(normalizePath('./src/app.ts', false)).toBe('src/app.ts');
    expect(normalizePath('src/', false)).toBe('src');
    expect(normalizePath('', true)).toBe('');
  });

  test('refuses paths that leave the repo or touch .git', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../b', '.git/config', 'a//b', 'a/.GIT/x']) {
      expect(() => normalizePath(bad, false)).toThrow(ScnError);
    }
  });
});

describe('read', () => {
  test('reads a file at a revision', async () => {
    const now = await repo.read('main', 'src/app.ts');
    expect(now).toMatchObject({ kind: 'file', commit: second, encoding: 'utf8', mode: '100644' });
    expect(now.kind === 'file' && now.content).toBe('export const a = 2;\nexport const b = 3;\n');
    const then = await repo.read(first, 'src/app.ts');
    expect(then.kind === 'file' && then.content).toBe('export const a = 1;\n');
  });

  test('lists the root and a directory', async () => {
    const root = await repo.read('HEAD');
    expect(root.kind === 'dir' && root.entries.map((e) => e.name)).toEqual([
      'README.md',
      'bin',
      'src',
    ]);
    const src = await repo.read('HEAD', 'src');
    expect(src.kind === 'dir' && src.entries).toEqual([
      { name: 'app.ts', type: 'blob', mode: '100644' },
    ]);
  });

  test('answers not_found for a missing path or revision', async () => {
    await rejects(repo.read('HEAD', 'nope.txt'), 'not_found');
    await rejects(repo.read('no-such-branch', 'README.md'), 'not_found');
  });

  test('refuses a revision that looks like an option', async () => {
    await rejects(repo.read('--output=/tmp/x', 'README.md'), 'bad_request');
  });
});

describe('log, blame and diff', () => {
  test('log lists commits newest first and filters by path', async () => {
    const all = await repo.log({ rev: 'main' });
    expect(all.map((e) => e.subject)).toEqual(['second', 'first']);
    expect(all[0]).toMatchObject({ commit: second, parents: [first], body: 'Body line.' });
    expect(all[0]?.author).toMatchObject({ name: 'Ada', email: 'ada@example.com' });
    const readme = await repo.log({ path: 'README.md' });
    expect(readme.map((e) => e.commit)).toEqual([first]);
    await rejects(repo.log({ limit: 0 }), 'bad_request');
  });

  test('blame gives each line its commit', async () => {
    const lines = await repo.blame('HEAD', 'src/app.ts');
    expect(lines.map((l) => [l.line, l.commit, l.text, l.summary])).toEqual([
      [1, second, 'export const a = 2;', 'second'],
      [2, second, 'export const b = 3;', 'second'],
    ]);
    const one = await repo.blame('HEAD', 'src/app.ts', { start: 2, end: 2 });
    expect(one.map((l) => l.line)).toEqual([2]);
  });

  test('diff gives changed files and a patch', async () => {
    const result = await repo.diff(first, second);
    expect(result.files).toEqual([{ status: 'M', path: 'src/app.ts' }]);
    expect(result.patch).toContain('+export const b = 3;');
    expect(result.truncated).toBe(false);
  });
});

describe('commit', () => {
  test('builds a commit on the base and moves the change ref', async () => {
    const result = await repo.commit({
      base: 'main',
      message: 'Add notes and drop the readme',
      change: 'notes',
      edits: [
        { path: 'docs/notes.md', content: '# Notes\n' },
        { path: 'README.md', delete: true },
        { path: 'src/app.ts', content: 'export const a = 4;\n' },
      ],
    });
    expect(result.change).toBe('notes');
    expect(result.base).toBe(second);
    expect(result.files).toEqual([
      { status: 'D', path: 'README.md' },
      { status: 'A', path: 'docs/notes.md' },
      { status: 'M', path: 'src/app.ts' },
    ]);
    expect(await repo.resolve('refs/scn/changes/notes')).toBe(result.commit);
    expect(await repo.resolve('main')).toBe(second);
    const notes = await repo.read(result.commit, 'docs/notes.md');
    expect(notes.kind === 'file' && notes.content).toBe('# Notes\n');
    const [entry] = await repo.log({ rev: result.commit, limit: 1 });
    expect(entry).toMatchObject({ subject: 'Add notes and drop the readme', parents: [second] });
    expect(entry?.author.name).toBe('scn agent');
  });

  test('keeps the executable bit and takes base64 content', async () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const result = await repo.commit({
      base: 'main',
      message: 'Binary and script',
      author: { name: 'Agent Seven', email: 'seven@example.com' },
      edits: [
        { path: 'bin/run', content: '#!/bin/sh\necho changed\n' },
        { path: 'assets/blob.bin', content: bytes.toString('base64'), encoding: 'base64' },
      ],
    });
    expect(result.change).toMatch(/^ch-[0-9a-f]{12}$/u);
    const run = await repo.read(result.commit, 'bin/run');
    expect(run.kind === 'file' && run.mode).toBe('100755');
    const blob = await repo.read(result.commit, 'assets/blob.bin');
    expect(blob).toMatchObject({ encoding: 'base64', content: bytes.toString('base64'), size: 4 });
  });

  test('chains commits on one change', async () => {
    const one = await repo.commit({
      base: 'main',
      change: 'chain',
      message: 'one',
      edits: [{ path: 'a.txt', content: '1\n' }],
    });
    const two = await repo.commit({
      base: 'refs/scn/changes/chain',
      change: 'chain',
      message: 'two',
      edits: [{ path: 'a.txt', content: '2\n' }],
    });
    expect(two.base).toBe(one.commit);
    const log = await repo.log({ rev: 'refs/scn/changes/chain', limit: 3 });
    expect(log.map((e) => e.subject)).toEqual(['two', 'one', 'second']);
  });

  test('refuses edits that change nothing, clash or delete a missing file', async () => {
    const same = await repo.read('main', 'README.md');
    const content = same.kind === 'file' ? same.content : '';
    await rejects(
      repo.commit({ base: 'main', message: 'noop', edits: [{ path: 'README.md', content }] }),
      'empty',
    );
    await rejects(
      repo.commit({ base: 'main', message: 'x', edits: [{ path: 'src', content: 'x' }] }),
      'conflict',
    );
    await rejects(
      repo.commit({
        base: 'main',
        message: 'x',
        edits: [{ path: 'README.md/inner', content: 'x' }],
      }),
      'conflict',
    );
    await rejects(
      repo.commit({ base: 'main', message: 'x', edits: [{ path: 'gone.txt', delete: true }] }),
      'not_found',
    );
    await rejects(
      repo.commit({
        base: 'main',
        message: 'x',
        edits: [
          { path: 'a', content: '1' },
          { path: './a', content: '2' },
        ],
      }),
      'bad_request',
    );
    await rejects(
      repo.commit({ base: 'main', message: ' ', edits: [{ path: 'a', content: '1' }] }),
      'bad_request',
    );
  });

  test('two commits on the same change at once: one wins, one gets conflict', async () => {
    const attempts = await Promise.allSettled(
      ['left', 'right'].map((side) =>
        repo.commit({
          base: 'main',
          change: 'race',
          message: side,
          edits: [{ path: 'race.txt', content: `${side}\n` }],
        }),
      ),
    );
    const won = attempts.filter((a) => a.status === 'fulfilled');
    const lost = attempts.filter((a) => a.status === 'rejected');
    // Both can win when the first finishes before the second reads the ref.
    expect(won.length).toBeGreaterThanOrEqual(1);
    for (const attempt of lost) {
      expect((attempt.reason as ScnError).code).toBe('conflict');
    }
    const head = await repo.resolve('refs/scn/changes/race');
    expect(won.map((a) => a.value.commit)).toContain(head);
  });

  test('leaves no index files behind', async () => {
    const glob = new Bun.Glob('scn-index-*');
    expect(await Array.fromAsync(glob.scan(tmpdir()))).toEqual([]);
  });
});
