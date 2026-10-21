import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Registry, socketPath } from '../src/registry.ts';
import { serve } from '../src/server.ts';

let dir: string;
let server: ReturnType<typeof serve>;
let socket: string;

async function post(route: string, body: unknown) {
  const response = await fetch(`http://scn${route}`, {
    unix: socket,
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'scn-srv-'));
  const seed = path.join(dir, 'seed');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'a@x',
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'a@x',
  };
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', seed]);
  await Bun.write(path.join(seed, 'README.md'), 'hello\n');
  Bun.spawnSync(['git', '-C', seed, 'add', '.'], { env });
  Bun.spawnSync(['git', '-C', seed, 'commit', '-q', '-m', 'first'], { env });
  const home = path.join(dir, 'home');
  const registry = new Registry(home);
  await registry.add('demo', seed);
  socket = socketPath(home);
  server = serve(registry, socket);
});

afterAll(async () => {
  await server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

test('the socket is private to this user', async () => {
  expect((await stat(socket)).mode & 0o777).toBe(0o600);
});

test('health and repo list', async () => {
  const health = await fetch('http://scn/v1/health', { unix: socket });
  expect(await health.json()).toEqual({ ok: true });
  const repos = await fetch('http://scn/v1/repos', { unix: socket });
  expect(await repos.json()).toEqual({ repos: ['demo'] });
});

test('commit, then read the commit back', async () => {
  const commit = await post('/v1/repos/demo/commit', {
    base: 'main',
    message: 'Say hi',
    change: 'hi',
    edits: [{ path: 'hi.txt', content: 'hi\n' }],
  });
  expect(commit.status).toBe(200);
  expect(commit.body.files).toEqual([{ status: 'A', path: 'hi.txt' }]);
  const read = await post('/v1/repos/demo/read', { rev: 'refs/scn/changes/hi', path: 'hi.txt' });
  expect(read.body).toMatchObject({ kind: 'file', content: 'hi\n', commit: commit.body.commit });
});

test('errors come back as JSON with a code', async () => {
  expect(await post('/v1/repos/demo/read', { path: 'missing' })).toMatchObject({
    status: 404,
    body: { error: { code: 'not_found' } },
  });
  expect(await post('/v1/repos/nope/read', {})).toMatchObject({ status: 404 });
  expect(await post('/v1/repos/demo/teleport', {})).toMatchObject({ status: 404 });
  expect(await post('/v1/repos/demo/read', 'not json')).toMatchObject({
    status: 400,
    body: { error: { code: 'bad_request' } },
  });
  expect(
    await post('/v1/repos/demo/commit', { base: 'main', message: 'x', edits: 'no' }),
  ).toMatchObject({
    status: 400,
    body: { error: { message: '"edits" must be an array.' } },
  });
});
