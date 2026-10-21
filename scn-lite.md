Agent source control on the Mac mini

# scn-lite

A small daemon over a bare git repo. Agents call it to read code, commit and land work on main. It borrows the "source control as an API" idea from Anthropic's Scion and keeps plain git underneath.

Proposal. Nothing is built yet.

## Where things live

Today

Each agent owns a full copy and talks to GitHub by itself. Agents find out about each other only when a push fails. macOS processes every file the agents write.

With scn-lite

Agents talk to one daemon. The daemon owns the bare repo and is the only thing that writes main. Sandboxes are APFS clones on the same volume, so each one takes about a second to make.

## Life of one change

The agent's job ends at submit(). The daemon decides if the change lands. Red paths need the agent to do more work. The blue path is automatic: another change landed first, so the daemon merges again.

## What changes day to day

| When you | Today | With scn-lite |
| --- | --- | --- |
| Start an agent task | Clone or add a worktree, then install packages. This takes minutes. | The daemon makes a `cp -c` sandbox in about a second. Packages come from the shared store. |
| Read code or history | The agent runs `git log` and `git blame` in its own copy. | The agent calls `read`, `log` or `blame`. A SQLite index answers history questions. |
| Commit | `git add`, `commit` and `push` from each worktree. | One `commit(base, edits)` call. There is nothing to push. |
| Land on main | Push or open a PR. GitHub rejects a push that is behind main. | Call `submit()`. The queue merges, tests and moves main. |
| Two agents finish at once | One push wins. The other agent fetches, rebases and tries again. | The queue takes them in order. A lost race retries with no agent work. |
| Hit a conflict | Found at push or PR time. The agent rebases in its worktree. | Found by `merge-tree` before tests run. The agent gets the conflicted files. |
| A change keeps failing | The agent keeps trying. You find out when you look at the PR. | After 3 failed attempts the queue parks it as `stuck`. It shows in `scn queue`. |
| Use file watchers | HMR and `tsc --watch` work everywhere. | Watchers do not fire on the Agents volume. Keep watched projects on the main volume. |
| Edit by hand in your IDE | Clone from GitHub as usual. | The same. Your clone pulls from the GitHub mirror. |

## CI in two tiers

Both tiers run on the Mac mini. Tier 1 decides if a change lands, so it must stay fast. Tier 2 can be slow, because it only decides if a commit deploys. The runner runs at background priority so it never slows the queue or the agents.

## Seeing failures

The daemon writes one SQLite row for each queue attempt. It never deletes rows. Most failures fix themselves in the flow, and the log keeps them as history. Run `scn queue` for live work and `scn log --failed` for history.

landedMain moved to this change.

retriedMain moved first. The daemon merged again with no agent work.

conflictThe conflicted files went back to the agent.

tests_failedThe logs went back to the agent. If the same diff passes later, the test is marked flaky.

stuck3 failed attempts on one change. The queue stops and waits for you.

## Build plan

1. **Agents volume**15 min

   Make the APFS volume, turn off Spotlight and the fseventsd log, and move the package caches to it.
2. **Daemon over the bare repo**1 day

   `read`, `diff`, `log`, `blame` and `commit(base, edits)` on top of git plumbing.
3. **MCP server**2 hours

   Expose the daemon calls as tools so agent sessions use them in place of their own git commands.
4. **Merge queue with attempt log**1 day

   `merge-tree`, the tier 1 gate in a `cp -c` sandbox, CAS on main, the SQLite log and a retry cap of 3.
5. **Self-hosted runner**half a day

   Install the Actions runner on the Mac mini as a separate `ci` user. Use a launchd service with `ProcessType Background` and a work folder on the Agents volume. Change `runs-on` to `self-hosted` and put deploy behind `needs:`. Let the daemon's token bypass the branch protection on main.

**Later:** SQLite history index, flaky test report, approval rules for paths such as `infra/`, a Linux VM runner for Linux and container jobs, and the monitor agent that reads the attempt log.

## What stays the same

**Plain git**The bare repo is a normal git repo. Every git tool and command still works on it.

**GitHub**The mirror gets every change to main. It is also your backup and your way out.

**Review**Green tests are the only gate at first. You can add a human approval step to the queue later.