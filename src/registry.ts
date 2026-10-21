import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { ScnError } from './errors.ts';
import { git } from './git.ts';
import { Repo } from './repo.ts';

/** Where the daemon keeps its repos, its socket and later its database. */
export function defaultHome(): string {
  return process.env.SCN_HOME ?? path.join(homedir(), 'scn');
}

export function socketPath(home: string): string {
  return path.join(home, 'scn.sock');
}

function checkName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name) || name.endsWith('.git')) {
    throw new ScnError('bad_request', `"${name}" is not a valid repo name.`);
  }
}

/** The bare repos under `<home>/repos/<name>.git`. */
export class Registry {
  constructor(readonly home: string) {}

  private dir(name: string): string {
    return path.join(this.home, 'repos', `${name}.git`);
  }

  open(name: string): Repo {
    checkName(name);
    const dir = this.dir(name);
    if (!existsSync(dir)) {
      throw new ScnError('not_found', `No repo is named "${name}".`);
    }
    return new Repo(name, dir);
  }

  async list(): Promise<Array<string>> {
    const root = path.join(this.home, 'repos');
    if (!existsSync(root)) {
      return [];
    }
    return (await readdir(root))
      .filter((entry) => entry.endsWith('.git'))
      .map((entry) => entry.slice(0, -4))
      .sort();
  }

  /** Makes a bare clone of `url`. The clone keeps `url` as origin, the future mirror. */
  async add(name: string, url: string): Promise<Repo> {
    checkName(name);
    const dir = this.dir(name);
    if (existsSync(dir)) {
      throw new ScnError('conflict', `A repo named "${name}" already exists.`);
    }
    await mkdir(path.dirname(dir), { recursive: true });
    await git(null, ['clone', '--bare', '--', url, dir]);
    return new Repo(name, dir);
  }
}
