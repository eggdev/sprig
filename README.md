# scn-lite

A small daemon over bare git repos. Agents call it to read code and commit. See [PLAN.md](./PLAN.md) for the build plan.

## Status

| Step                            | State                                                      |
| ------------------------------- | ---------------------------------------------------------- |
| 1. Agents volume                | Not started. Needs `sudo`.                                 |
| 2. Daemon over the bare repo    | Done: `resolve`, `read`, `log`, `blame`, `diff`, `commit`. |
| 3. MCP server                   | Not started.                                               |
| 4. Merge queue with attempt log | Not started.                                               |
| 5. Self-hosted runner           | Not started.                                               |

## Use

```sh
bun install
bun src/cli.ts repo add neighborhood git@github.com:eggdev/neighborhood.git
bun src/cli.ts serve          # listens on ~/scn/scn.sock
bun src/cli.ts log neighborhood main
bun src/cli.ts read neighborhood AGENTS.md
bun src/cli.ts call neighborhood commit '{"base":"main","message":"docs: x","edits":[{"path":"a.md","content":"x\n"}]}'
```

`SCN_HOME` moves the home folder. The default is `~/scn`.

## How a commit works

`commit(base, edits)` reads the base tree into a private index, writes each edit as a blob, and makes a commit with `commit-tree`. It then moves `refs/scn/changes/<change>` with a compare-and-swap. No work tree is touched, and `main` does not move. Landing on `main` is the merge queue's job (step 4).

## Checks

```sh
bun run check   # typecheck, lint, format-check, tests
```
