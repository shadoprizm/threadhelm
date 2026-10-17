# Operations

Run one active hub for a deployment. State is stored in `data/control.sqlite`, alongside private `data/config.json`. The database contains normalized source metadata, bounded latest excerpts, the watch list, action inbox, coordinator history, and Codex command delivery records. Full source transcripts are not mirrored.

## macOS

Create `data/config.json`, commit the release, then run `python3 scripts/install-local.py`. The installer refuses a dirty source tree, installs exact dependencies, runs all tests and the build before stopping the service, copies a checksum-verified artifact to `~/.local/share/threadhelm`, preserves existing configuration/state, backs up code/data and the LaunchAgent, writes `release.json`, and installs the per-user `io.threadhelm.control` service. An existing `~/.local/share/astra-control` deployment is migrated into the new location and its former service definition is preserved in the printed backup. Node, npm, and Git must be on PATH. The machine must remain awake.

Stop with `launchctl bootout gui/$(id -u)/io.threadhelm.control`. Restore deployment files and the LaunchAgent from the printed backup location to roll back. Keep `data/` to preserve the inbox.

## Linux

See docs/HOSTING.md. Install a user service with `python3 scripts/install-linux.py`. It applies the same clean-tree, test, build, checksum, release-manifest, backup, and post-start service checks as the macOS installer. It preserves the data directory and separately backs up configured credential/device files. It does not configure DNS, tunnels, SSH keys, or system firewall rules.

## Updates and migration

Finish or pause dashboard-managed work before restarting or moving the hub: the current version owns App Server subprocesses, so stopping it closes its runtime connections. Pending permission IDs become invalid after restart and must never be replayed. For a dashboard-managed task, the owner can use the expired decision panel to explicitly allow the exact request to continue or decline it. Never retry an uncertain action automatically.

Back up SQLite with its backup API or after stopping the hub; copying only a live `.sqlite` file can omit WAL data. Back up private configuration and connector credential/device files separately, preserving `0600` permissions. Preserve host and source IDs when moving the hub so task/source keys remain stable. Mark transferred managed sessions as unowned until their state is reconciled. Do not run two hubs against the same database.

Schema migrations run in numeric order and retain existing Codex task keys, watches, managed state, inbox links, and command history. Before changing an existing database, the runner checkpoints the WAL and creates an owner-only SQLite backup under `data/migration-backups/`. Restore and verify that backup before promotion. An incompatible external adapter is expected to show its own health error while the rest of the dashboard remains available; do not remove its last snapshot merely because a poll failed.

The CLI login, SSH setup, and repository paths belong to each execution machine. A host that cannot be reached is displayed as offline; that does not prove its agents stopped.

## Coordinator authority

The coordinator runs only when the owner submits a coordinator message. Its default configuration is `{"model":"gpt-5.6-terra","reasoningEffort":"xhigh","maxActions":12,"maxInputChars":800000}`. `maxInputChars` is a generous high-water rail for one complete prompt, not a daily usage budget; it prevents a malformed or runaway workspace snapshot from crowding out the coordinator. Each completed coordinator message records reported token usage when Codex provides it, or a clearly labelled estimate otherwise. Override these fields under `coordinator` in `data/config.json` when necessary. `supervisorName` changes its display name in the private dashboard.

Coordinator output is proposal-only in this release. The server does not execute emitted actions, including sends, creates, inbox resolution, or approval responses. Direct owner controls continue to use the command and approval paths. Their audit rows identify the actor, and the policy truth table in `src/policy.ts` denies autopilot execution until a later release deliberately enables bounded classes.

On the first startup of this hardening release, ThreadHelm stores an immutable aggregate decision baseline in SQLite. `/api/state` exposes its capture time, approval count, open and expired count, and median and p90 time from creation to the last recorded decision transition. It contains no transcript or approval content. Use it as the pre-briefing comparison point; legacy records can include source-side resolution time, so treat it as an operational baseline rather than a precise human-timing study.

Each Codex App Server reports its version during initialization. Controls are disabled unless that exact version is in this release's tested allowlist or the host's private `codexVersions` list. Keep inventory visible, inspect the machine diagnostic, run the disposable capability probe, and add a version only after its required controls pass.
