#!/usr/bin/env bun
import { mkdirSync } from 'node:fs';

import { defaultHome, Registry, socketPath } from './registry.ts';
import { serve } from './server.ts';

const usage = `Usage:
  scn serve                          Run the daemon on <home>/scn.sock
  scn repo add <name> <url>          Make a bare clone the daemon owns
  scn repo list                      List the repos
  scn call <repo> <method> [json]    Call the daemon. Reads json from stdin when it is "-"
  scn read <repo> <path> [rev]       Print one file, or list one directory
  scn log <repo> [rev] [path]        Print recent commits

Methods: resolve, read, log, blame, diff, commit.
SCN_HOME sets the home folder. The default is ~/scn.`;

const home = defaultHome();

async function call(repo: string, method: string, body: unknown): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`http://scn/v1/repos/${encodeURIComponent(repo)}/${method}`, {
      unix: socketPath(home),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    fail(`The daemon is not running on ${socketPath(home)}. Start it with "scn serve".`);
  }
  const value = (await response.json()) as any;
  if (!response.ok) {
    fail(`${value.error?.code ?? response.status}: ${value.error?.message ?? 'unknown error'}`);
  }
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'serve': {
    mkdirSync(home, { recursive: true });
    const server = serve(new Registry(home), socketPath(home));
    console.log(`scn-lite is listening on ${server.url}`);
    break;
  }
  case 'repo': {
    const registry = new Registry(home);
    if (args[0] === 'add' && args[1] && args[2]) {
      const repo = await registry.add(args[1], args[2]);
      console.log(`Added ${repo.name} at ${repo.gitDir}. HEAD is ${await repo.resolve('HEAD')}.`);
    } else if (args[0] === 'list') {
      console.log((await registry.list()).join('\n'));
    } else {
      fail(usage);
    }
    break;
  }
  case 'call': {
    const [repo, method, raw] = args;
    if (!repo || !method) {
      fail(usage);
    }
    const text = raw === '-' ? await Bun.stdin.text() : (raw ?? '{}');
    console.log(JSON.stringify(await call(repo, method, JSON.parse(text)), null, 2));
    break;
  }
  case 'read': {
    const [repo, path, rev] = args;
    if (!repo || path === undefined) {
      fail(usage);
    }
    const result = await call(repo, 'read', { path, rev });
    if (result.kind === 'dir') {
      for (const entry of result.entries) {
        console.log(entry.type === 'tree' ? `${entry.name}/` : entry.name);
      }
    } else if (result.encoding === 'utf8') {
      process.stdout.write(result.content);
    } else {
      process.stdout.write(Buffer.from(result.content, 'base64'));
    }
    break;
  }
  case 'log': {
    const [repo, rev, path] = args;
    if (!repo) {
      fail(usage);
    }
    for (const entry of await call(repo, 'log', { rev, path })) {
      console.log(
        `${entry.commit.slice(0, 12)} ${entry.author.date.slice(0, 10)} ${entry.author.name}  ${entry.subject}`,
      );
    }
    break;
  }
  default:
    fail(usage);
}
