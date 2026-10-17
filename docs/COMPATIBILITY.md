# Compatibility and capability contract

This document says what ThreadHelm can observe and control today. It is intentionally narrower than a logo-level “supported” claim: a source may expose inventory and detail without allowing ThreadHelm to mutate its sessions.

## Capability levels

- **Observed** — ThreadHelm reads source-owned state and presents bounded metadata or detail.
- **Conditional** — the action exists, but only when the current session ownership and source state permit it.
- **Native only** — ThreadHelm can surface the event or a deep link, but the action remains in the source client.
- **Planned** — roadmap work; do not rely on it.

An unavailable capability must be disabled or omitted with a reason. Adapters must not infer support because another provider has a similar operation.

## Source matrix

| Capability | Codex | Claude Code | Hermes | OpenClaw | Open WebUI |
| --- | --- | --- | --- | --- | --- |
| Discover existing non-archived work | Observed from configured local or SSH runtime projections, including subagents; ChatGPT/Codex Cloud is not captured | Observed from owner-local parent-session transcripts | Observed for configured profiles | Observed for configured agents/sessions | Observed for owner-scoped chats |
| Include pinned archived work | No | No | Observed | Observed | Observed |
| Bounded latest excerpt | Observed | Observed | Observed | Observed | Observed |
| Bounded recent detail | Observed | Observed | Observed | Observed | Observed |
| Source-native deep link | `codex://` link | No | When the source supplies one | When the source supplies one | When `deepLinkBase` is configured |
| Authoritative active state | Writer-lock aware | Live process-backed session state; transcript-only history is heuristic | No; “Recently active” is heuristic | Source-reported active run/state | Source-reported unfinished generation |
| Create new work | Conditional; saved Codex project or observed checkout | Native only | Native only | Native only | Native only |
| Resume or send a message | Conditional; idle task must be available to the hub | Native only | Native only | Native only | Native only |
| Steer active work | Conditional; dashboard-managed active task | Native only | Native only | Native only | Native only |
| Interrupt active work | Conditional; dashboard-managed active task | Native only | Native only | Native only | Native only |
| Answer live requests | Conditional; supported requests on the hub-owned App Server connection | Native only; waiting state can appear in ThreadHelm’s inbox | Native only | Native only; request can appear in ThreadHelm’s inbox | Native only |
| Archive | Conditional; inactive task with no unresolved approval | Native only | Native only | Native only | Native only |
| Git/worktree context | Observed; isolated worktree creation supported for new Git tasks | Working path and branch observed; no Git actions | Not advertised | Not advertised | Not advertised |
| Watch and completion inbox | Supported, including live requests | Waiting-state inbox and watched active-to-idle completion | Watched background completions and failures | Watched completions, failures, and native approval notifications | Failure observation; ordinary chat remains quiet |

All sources can fail independently. ThreadHelm retains the last good snapshot, marks it stale according to that adapter’s freshness window, and reports the connector error without removing other sources.

## Codex ownership rules

A Codex row being visible does not mean the hub owns its live connection.

- Existing tasks are discovered through read-only projections on configured local or SSH hosts. The standalone panel does not capture ChatGPT conversations or Codex Cloud tasks.
- Active desktop-owned tasks remain read-only and open in Codex through their deep link.
- An idle, unowned task can be resumed when the runtime accepts it.
- Tasks started by ThreadHelm use its App Server subprocess and expose the supported live actions while that connection remains valid.
- Restarting or stopping the hub closes those subprocess connections. Pending approvals become invalid and must not be replayed. For a dashboard-managed task, the expired decision panel makes clear that the prior response is gone and lets the owner either explicitly continue the exact request or decline it.
- App Server and the local projections are version-sensitive. Incompatibility must fail visibly; ThreadHelm never edits the Codex database, authentication, permission policy, or desktop process.
- The App Server initialization response is checked against an exact tested-version allowlist. An unknown version leaves observation available but disables send, create, steer, interrupt, archive, and approval responses until a disposable probe passes.

New Git tasks use a sibling worktree and a new `codex/*` branch by default. This prevents two tasks from writing in one directory, but it does not compare task scopes or guarantee conflict-free integration.

## Observation semantics

| Source | Status basis | Default refresh/freshness behavior |
| --- | --- | --- |
| Codex | Turn state plus advisory writer lock | Host snapshot cycle; disconnected hosts report offline without claiming the agent stopped |
| Claude Code | Live session-state file tied to a running process; otherwise transcript history | Local scan or bounded read-only SSH bridge every 12 seconds; 45-second freshness window; unchanged local transcript summaries are cached |
| Hermes | Source activity flag | Full polling every 12 seconds; 180-second freshness window for large paginated inventories |
| OpenClaw | Protocol-v4 session events and source-reported active run IDs | Event subscription plus reconciliation at least every 60 seconds; 90-second freshness window |
| Open WebUI | Owner chat inventory and unfinished-generation flag | Polling every 12 seconds; 45-second freshness window |

Normalized statuses are `active`, `recent`, `waiting`, `idle`, `completed`, `failed`, `offline`, and `unknown`. Each item also carries `authoritative` or `heuristic` confidence. “Offline” describes the observation channel, not necessarily the underlying agent.

Work from different sources is merged only when both carry the same exact propagated correlation identifier. Title, excerpt, model, path, and timestamp similarity are never sufficient.

## Data boundaries

- Latest excerpts are limited to 4,000 characters.
- Detail is fetched on demand and limited to 30 entries, 12,000 characters per entry, and 180,000 characters total.
- Full transcripts remain in the source system.
- Credentials are read from owner-only files and are not persisted to ThreadHelm’s SQLite database or returned to the browser. Claude Code uses no provider credential; its configured activity directories remain source-owned and are never modified. A remote hub may reuse an existing noninteractive SSH trust path to query only the workstation's bounded ThreadHelm read endpoints.
- Runtime inventory excludes prompts, responses, and raw completion traffic.
- Locality is `unknown` unless a source reports it, an exact model is present in local Runtime inventory, or configuration maps an exact provider, model, or profile.

## Tested baseline

The live acceptance record dated 2026-09-19 verified:

- Codex `0.154.0-alpha.6.2` on macOS;
- Codex `0.151.0-alpha.7.2` on Linux;
- Codex Desktop `0.155.0-alpha.9.2` and CLI `0.155.1` completed App Server initialization and a read-only thread inventory probe on macOS;
- Claude Code transcript and live-session capture against local `2.1.266` records on macOS;
- the pinned OpenClaw protocol-v4 client packages at `2026.8.1` against a fixture Gateway;
- live inventory from Hermes, OpenClaw, and Open WebUI in the reference owner-only deployment;
- Node.js 22 on macOS and Linux in GitHub checks.

The live acceptance record did not capture stable Hermes, OpenClaw Gateway, or Open WebUI application version identifiers. Their inventory was verified against the reference deployment, but that is not a blanket version guarantee. See [verification](VERIFICATION.md) for counts, checks, and explicit gaps.

When reporting compatibility, include:

1. ThreadHelm version and commit;
2. operating system and Node.js version;
3. source name and exact version, when available;
4. whether the failure affects inventory, detail, status, deep links, or a control;
5. a sanitized error or minimal synthetic fixture.

Never attach a real transcript, credential, private hostname, or screenshot containing personal work.

## Adapter acceptance bar

A new adapter is ready only when it has:

- a documented and supportable source API/protocol, or an explicitly version-scoped, read-only local projection with no mutation capability;
- explicit inventory, detail, event, health, and model-catalog behavior where applicable;
- a capability declaration that defaults unsupported mutations to false;
- bounded payloads, redaction, loopback/private transport, and isolated failure behavior;
- pagination/reconnect handling where applicable, or bounded filesystem discovery for local projections;
- synthetic tests for incompatible payloads, stale state, duplicates, and source-specific status semantics;
- documentation here and in `config.example.json`;
- live verification with disposable, non-sensitive work before ongoing use.

Claude Code controls and other future providers must preserve their native ownership and permission semantics rather than being forced into Codex-shaped controls. The current Claude adapter is intentionally limited to owner-local observation.
