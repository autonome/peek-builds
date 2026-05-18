fix(profiles): make single-instance lock per-profile, not app-global

`app.setPath('userData', profileDataPath)` ran AFTER
`requestSingleInstanceLock()`, so Electron's lock resolved against the
default userData dir. The lock was effectively app-global: two packaged
Peeks under different PROFILE= values could not coexist.

Move the per-profile setPath (plus initMainLog) ahead of the lock
acquisition. Electron stores SingletonLock inside userData, so the lock
becomes per-profile-dir: distinct PROFILE= packaged Peeks now coexist,
while two under the same PROFILE= still block as before.

Unblocks parallel-profile workflows — running a perf-repro or
isolated-agent packaged profile alongside the user's prod session, no
"quit Peek first" friction.

Transitional caveat: if an OLD binary is already running (its lock at
the root userData path) and a NEW binary launches against the same
profile, the new lock check looks at the per-profile sub-path and
doesn't see the old root lock. Two processes against one profile dir is
unsafe. After the next clean restart on each install, both old and new
binaries are on the new lock path and the invariant holds again.

Verified: two packaged Peeks launched with PROFILE=lockcheck-a and
PROFILE=lockcheck-b coexist; each writes its own SingletonLock inside
its per-profile dir.
