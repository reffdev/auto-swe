# Bwrap Sandbox — Smoke Test Procedure

The unit tests in `src/server/util/sandbox.test.ts` cover argv generation
deterministically on every platform without spawning a real `bwrap`. This
document describes the manual end-to-end procedure for verifying isolation
on a real Linux host.

## Prerequisites

- Linux host
- `bubblewrap` installed: `apt install bubblewrap` (Debian/Ubuntu) or
  `dnf install bubblewrap` (Fedora) or `pacman -S bubblewrap` (Arch)
- A working open-swe install with at least one project configured

## Enable the sandbox

1. Open the Foreman Configuration page in the frontend.
2. Toggle **Agent Subprocess Sandbox** on. Save.
3. Restart the server. Logs should include:

   ```
   [sandbox] bwrap detected — agent subprocesses can be sandboxed when sandbox_enabled=1
   ```

   If you see `[sandbox] bwrap not found`, install bubblewrap and restart.

## Positive smoke test

Dispatch a Foreman task with the following description:

> Use the `runCommand` tool to run each of these commands in turn, capturing
> the output of each: `pwd`, `whoami`, `ls -la /home`, `ls -la /tmp`,
> `cat /etc/hostname`. Then call `submitResult` with no file changes — this
> is a sandbox check, not real work.

Expected results in the run output:

| Command | Expected | Why |
|---|---|---|
| `pwd` | The worktree path under `.orch-worktrees/foreman-XXXXXXXX` | `--chdir <worktree>` |
| `whoami` | The orchestrator's user (bwrap doesn't change UID without `--unshare-user`, which we don't use) | UID identity preserved |
| `ls -la /home` | Just `/home/swe` (the synthetic HOME) — **the orchestrator user's actual home is invisible** | `/home` is not bound; the `/home/swe` tmpfs takes precedence |
| `ls -la /tmp` | Empty (a fresh tmpfs) — **the host's `/tmp` is invisible** | `--tmpfs /tmp` |
| `cat /etc/hostname` | The host's hostname (read-only system bind) | `/etc` system files are RO bound |

## Negative smoke tests (verify isolation)

Dispatch a Foreman task with each of these in turn and verify the agent
**cannot** access the listed paths:

1. **DB file is invisible**:
   `runCommand cat /opt/swe/open-swe.db` (or wherever your DB lives)
   — should fail with `No such file or directory`.

2. **`.swe/` memory dir is invisible**:
   `runCommand ls /opt/swe/.swe`
   — same.

3. **Orchestrator user's `~/.ssh` is invisible**:
   `runCommand cat ~/.ssh/config`
   — should fail because `$HOME` is `/home/swe` (a tmpfs), not the host's home.

4. **Host's `/tmp` is invisible**:
   On the host: `echo SECRET > /tmp/host-secret`. Then dispatch a task that
   does `runCommand cat /tmp/host-secret` — should fail.

5. **Network blocked for read-only stages**:
   For pipeline stages (scout, review) and the verifier, network is
   `--unshare-net`. A subprocess that tries `wget https://example.com` or
   `curl ...` from those stages should fail with a network error. Note
   that the agent's in-process `fetchUrl` and `lookupDocs` tools STILL work
   (those run in the orchestrator's network namespace, not in subprocesses).

6. **Worktree is read-only in scout/review/verifier**:
   For a review-stage agent, `runCommand touch /path/to/worktree/test.txt`
   should fail with `Read-only file system`.

## Real-task smoke test

Dispatch a normal Foreman code task that does real work:

1. Verify the task completes normally — `npm install`, builds, and tests
   all work inside the sandbox.
2. After the task completes, inspect the per-project cache:

   ```sh
   ls ~/.swe-cache/<project_id>/
   ```

   You should see `npm/`, `cache/`, `cargo/`, `local-share/` populated by
   whatever the task ran.

3. Dispatch a second task in the same project. Verify the second
   `npm install` is fast (warm cache via the bind mount).

## Disable smoke test

1. Toggle **Agent Subprocess Sandbox** off. Save. Restart.
2. Logs should NOT include any `[sandbox] bwrap detected` line at startup
   (the probe still runs but the per-stage `buildSandboxProfile` returns
   `undefined` because `sandbox_enabled = 0`).
3. Dispatch the same positive smoke-test task as above.
4. Verify `runCommand ls -la /home` now shows the host's actual `/home`
   (the orchestrator user is visible). The sandbox is fully bypassed.

## Failure-mode test

1. Re-enable the sandbox.
2. Force a runtime failure: temporarily make `bwrap` non-executable on the
   host: `sudo chmod -x $(which bwrap)`.
3. Dispatch a task. The first subprocess invocation should log
   `[sandbox] runtime failure (1/3): ...`. After three failures the cache
   flips off and you'll see `[sandbox] disabling sandbox for the rest of
   this process`.
4. Restore: `sudo chmod +x $(which bwrap)`. Restart the server. Sandbox
   should be working again on the next run.

## Cache reset

If a project's caches get corrupted (rare; usually only after a system
package upgrade that breaks ABI compatibility):

```sh
rm -rf ~/.swe-cache/<project_id>
```

The next task in that project will rebuild caches from cold.
