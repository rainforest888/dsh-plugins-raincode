# dsh-raincode

Make **raincode** the model layer of **DeepSeek Harness (dsh)**: a cheap model
pool with StablePrefix prompt caching, retries and failover, driven by a local
OpenAI-compatible gateway and shipped as dsh plugins.

One repository, two halves:

| Half | Language | Role |
|---|---|---|
| [`packages/`](./packages) | TypeScript | dsh plugins — translate dsh's `GenerateOptions` into the OpenAI wire format, stream chunks back, auto-spawn the gateway |
| [`crates/`](./crates) | Rust | the raincode gateway — model pool, prompt caching, retries/failover, skill network, capability refresh |

The plugins are the "mouth"; the gateway is the "brain". The plugins hold no
model logic.

## What it does

- Transparent takeover (best effort): dsh chat requests whose model is in the pool
  are served by the raincode adapter; a matching profile is derived from dsh's
  current model when dsh exposes one, otherwise set `mainModel` or a `role: main`
  profile.
- Model pool configured through dsh plugin settings (profiles with
  `role: main | subagent | any` and direction `tags`).
- Capability refresh from OpenRouter, DeepSWE and opencode usage leaderboards
  (top 15 refreshed weekly; any other model refreshed on demand).
- Prompt caching, retries and provider failover (`rc-pro`).
- Skill network: skills are indexed as an empty-body DAG that drills down to
  short leaf checklists; `raincode_learn` distills sessions into review-gated
  skills.
- Request logging and status (`/requests`, `raincode_status`).

## Packages

| Package | Focus | Tools / Commands |
|---|---|---|
| [`dsh-plugins-raincode-skill`](./packages/plugin-skill) | Skill self-evolution network — browse / search / load raincode skills and distill experience into `SKILL.md` | `/skills`, `raincode_skill_search`, `raincode_skill_load`, `raincode_learn`, `raincode_status` |
| [`dsh-plugins-raincode-routing`](./packages/plugin-routing) | Model auto-routing — a strong main model decomposes a large task and dispatches cheaper subagents by direction | `raincode_route`, `raincode_agent_tree`, `raincode_refresh_model`, `raincode_status` |
| [`@raincode-dsh/core`](./packages/core) | Shared adapter core (OpenAI wire serialization, SSE translation, gateway auto-spawn); published so the two plugins can resolve it independently | — |

## Gateway crates

| Crate | Role |
|---|---|
| `rc-pro` | OpenAI / Anthropic / compatible providers, cache keys, retries |
| `rc-profile` | model-pool registry and key management |
| `rc-gateway` | headless HTTP gateway |
| `rc-capability` | multi-source model capability refresh and scoring |
| `rc-skill` | `SKILL.md` store, DAG network, router and navigator |
| `rc-state` | SQLite persistence for skills / navigation / model profiles |
| `rc-cli` | `raincode proxy` + non-interactive profile / skill commands |

## Layout

```text
packages/
  core/            shared adapter core (adapter, serialize, translate, sse, gateway manager)
  plugin-skill/    dsh-plugins-raincode-skill
  plugin-routing/  dsh-plugins-raincode-routing
crates/            Rust workspace (see table above)
skills/            SKILL.md playbooks shipped with the skill network
agents/            agent role prompts (architect / coding / researcher)
docs/superpowers/  design specs and implementation plans
handoff/           handoff notes and project history
install.sh         build + install the raincode CLI (macOS / Linux)
install.ps1        build + install the raincode CLI (Windows)
```

## Quick start

Prerequisites: Rust `>= 1.75` for the gateway; dsh `>= 0.2.2-rc.1` and Node.js
`>= 22.19` to build/run the plugins.

1. Install the raincode CLI (`>= 0.1.0`):
   `cargo install --path crates/rc-cli` (or `./install.sh` / `install.ps1`).
2. Configure your model pool: `raincode setup` (writes `~/.raincode/profiles.toml`).
3. Start the gateway: `raincode proxy --port 8787`, then verify
   `curl http://127.0.0.1:8787/health` → `{"ok":true,"service":"raincode-gateway"}`.

## Install in dsh

Requires dsh `>= 0.2.2-rc.1` — see [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md)
for the API surface, the 0.2.2 changes and the verification notes.

In a development checkout, link both plugin packages into a profile (this is the
setup the 0.2.2 port was validated with):

```bash
dsh plugin --profile my-profile add \
  "link:$PWD/packages/plugin-routing" \
  "link:$PWD/packages/plugin-skill"
```

Each package ships a `cordis.patch.yml` and declares it under `dsh.bundle.patch`, so
adding the package to `dsh.profile.bundles` inserts its loader row automatically:

```yaml
- insert:
    - id: dsh-plugins-raincode-routing
      name: dsh-plugins-raincode-routing
    - id: dsh-plugins-raincode-skill
      name: dsh-plugins-raincode-skill
```

Check the wiring without starting the app:

```bash
dsh --profile my-profile --dump-config | tail -20
```

Settings show up under those two ids in dsh's settings UI. They are volatile:
edits apply to the next request, no restart. The gateway starts on demand when
`spawnGateway` is on; the binary is looked up as `gatewayBin` setting →
`RAINCODE_BIN` → repo `target/release/raincode` → `~/.raincode/bin` → `PATH`, so
`cargo build --release` in this repo is enough.

## Development

```bash
# TypeScript plugins
npm install            # links @raincode-dsh/core into each plugin via workspaces
npm run build          # builds core, plugin-skill, plugin-routing
npm test               # runs every package's vitest suite

# Rust gateway
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Build the release binary with `npm run backend:build` (or `cargo build --release`).

## Docs and history

- `docs/superpowers/specs/` — design documents for the gateway and the plugins.
- `docs/superpowers/plans/` — implementation plans (including the capability-score
  enrichment plan behind `tools/enrich_models.py`).
- [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md) — dsh 0.2.2 API surface, what
  changed, and how this repo adapts.
- [`docs/COMPETITORS.md`](./docs/COMPETITORS.md) — similar dsh plugins and where
  raincode differs.
- `handoff/` — handoff notes and a post-mortem of the earlier multi-agent
  refactor attempt.
- `skills/` — the default skill playbooks; `agents/` — role prompts for dsh
  subagents.

## License

MIT
