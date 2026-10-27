import { chmodSync, existsSync, lstatSync, rmSync } from 'node:fs';

import { ScnError } from './errors.ts';
import type { Registry } from './registry.ts';
import type { Edit, FileMode, Person, Repo } from './repo.ts';

type Body = Record<string, unknown>;

function field<T>(body: Body, key: string, kind: string, required: boolean): T | undefined {
  const value = body[key];
  if (value === undefined) {
    if (required) {
      throw new ScnError('bad_request', `"${key}" is required.`);
    }
    return undefined;
  }
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (actual !== kind) {
    throw new ScnError(
      'bad_request',
      `"${key}" must be ${kind === 'array' || kind === 'object' ? 'an' : 'a'} ${kind}.`,
    );
  }
  return value as T;
}

const str = (body: Body, key: string) => field<string>(body, key, 'string', true) as string;
const optStr = (body: Body, key: string) => field<string>(body, key, 'string', false);
const optNum = (body: Body, key: string) => field<number>(body, key, 'number', false);

function edits(body: Body): Array<Edit> {
  const list = field<Array<unknown>>(body, 'edits', 'array', true) as Array<unknown>;
  return list.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ScnError('bad_request', `edits[${index}] must be an object.`);
    }
    const edit = item as Body;
    const editPath = str(edit, 'path');
    if (edit.delete === true) {
      return { path: editPath, delete: true };
    }
    const encoding = optStr(edit, 'encoding');
    if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
      throw new ScnError('bad_request', `edits[${index}].encoding must be "utf8" or "base64".`);
    }
    return {
      path: editPath,
      content: str(edit, 'content'),
      encoding,
      mode: optStr(edit, 'mode') as FileMode | undefined,
    };
  });
}

function person(body: Body): Person | undefined {
  const value = field<Body>(body, 'author', 'object', false);
  return value === undefined ? undefined : { name: str(value, 'name'), email: str(value, 'email') };
}

/** One entry per daemon call. Each one reads its JSON body and calls the repo. */
const methods: Record<string, (repo: Repo, body: Body) => Promise<unknown>> = {
  resolve: async (repo, body) => ({ commit: await repo.resolve(str(body, 'rev')) }),
  read: (repo, body) => repo.read(optStr(body, 'rev') ?? 'HEAD', optStr(body, 'path') ?? ''),
  log: (repo, body) =>
    repo.log({
      rev: optStr(body, 'rev'),
      path: optStr(body, 'path'),
      limit: optNum(body, 'limit'),
      skip: optNum(body, 'skip'),
    }),
  blame: (repo, body) => {
    const start = optNum(body, 'start');
    const end = optNum(body, 'end');
    return repo.blame(
      optStr(body, 'rev') ?? 'HEAD',
      str(body, 'path'),
      start === undefined ? undefined : { start, end },
    );
  },
  diff: (repo, body) => {
    const paths = field<Array<unknown>>(body, 'paths', 'array', false) ?? [];
    if (!paths.every((p) => typeof p === 'string')) {
      throw new ScnError('bad_request', '"paths" must be an array of strings.');
    }
    return repo.diff(str(body, 'from'), str(body, 'to'), paths as Array<string>);
  },
  commit: (repo, body) =>
    repo.commit({
      base: str(body, 'base'),
      message: str(body, 'message'),
      edits: edits(body),
      change: optStr(body, 'change'),
      author: person(body),
    }),
};

export const methodNames = Object.keys(methods);

function json(status: number, value: unknown): Response {
  return Response.json(value, { status });
}

function errorResponse(error: unknown): Response {
  if (error instanceof ScnError) {
    return json(error.status, { error: { code: error.code, message: error.message } });
  }
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  return json(500, { error: { code: 'internal', message } });
}

/** Routes one HTTP request. Exported so tests can call it with no socket. */
export async function handle(registry: Registry, request: Request): Promise<Response> {
  try {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/v1/health') {
      return json(200, { ok: true });
    }
    if (request.method === 'GET' && pathname === '/v1/repos') {
      return json(200, { repos: await registry.list() });
    }
    const match = /^\/v1\/repos\/([^/]+)\/([^/]+)$/u.exec(pathname);
    const name = match?.[2] ?? '';
    const method = Object.hasOwn(methods, name) ? methods[name] : undefined;
    if (request.method !== 'POST' || !match || !method) {
      throw new ScnError('not_found', `No route for ${request.method} ${pathname}.`);
    }
    const repo = registry.open(decodeURIComponent(match[1] ?? ''));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ScnError('bad_request', 'The body must be JSON.');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ScnError('bad_request', 'The body must be a JSON object.');
    }
    return json(200, await method(repo, body as Body));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Listens on a unix socket that only this user can open. */
export function serve(registry: Registry, socket: string) {
  if (existsSync(socket)) {
    if (!lstatSync(socket).isSocket()) {
      throw new Error(`${socket} exists and is not a socket.`);
    }
    rmSync(socket);
  }
  const server = Bun.serve({ unix: socket, fetch: (request) => handle(registry, request) });
  chmodSync(socket, 0o600);
  return server;
}
