# Thread Worktrees

Use one branch and one worktree per write-capable thread.

This is the simplest way to stop branch collisions, token burn, and "where did my edits go?" failures.

## Rules

1. One thread = one branch.
2. One write thread = one `git worktree`.
3. Never start a new thread from a dirty worktree.
4. Never switch branches inside a dirty worktree unless you already committed or stashed the edits.
5. Treat the original repo folder as a parked workspace, not the place where every task starts.

## Start a New Thread

From the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\git\new-thread-worktree.ps1 -Name "docs control plane follow-up"
```

That creates:

- a fresh branch named like `thread/20260528-130501-docs-control-plane-follow-up`
- a sibling worktree under `..\_threads\`

Then move into the new folder:

```powershell
Set-Location ..\_threads\factory-20260528-130501-docs-control-plane-follow-up
```

Open the new Codex thread from that folder. The working directory is what keeps the thread isolated in practice.

## When the Current Workspace Is Dirty

If `git status --short` shows mixed edits, do not start the next task there.

Instead:

1. Leave the current workspace parked on its current branch.
2. Start the next task with `new-thread-worktree.ps1`.
3. Come back to the parked workspace only when you mean to finish or sort that exact branch.

This avoids accidental commits that mix two different jobs together.

## Clean Up Old Thread Worktrees

List worktrees:

```powershell
git worktree list
```

After a branch is merged and the worktree is no longer needed:

```powershell
git worktree remove ..\_threads\factory-20260528-130501-docs-control-plane-follow-up
git branch -d thread/20260528-130501-docs-control-plane-follow-up
```

If Git says the branch is not merged yet, stop and inspect before deleting anything.

## Why This Works

Branch names are just pointers. The real collisions happen because two tasks share the same working directory and uncommitted edits.

`git worktree` fixes the actual problem:

- each thread gets its own files on disk
- each thread gets its own branch
- branch switches in one thread do not stomp another thread's edits

## Current Safe Cleanup Rule

If a workspace contains mixed unrelated edits, do not "clean it up" by making a catch-all commit.

Split the concerns:

- ship or park the current branch on its own terms
- start all new work in a fresh thread worktree
