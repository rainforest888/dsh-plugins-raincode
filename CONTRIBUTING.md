# Contributing to dsh-raincode

Thanks for your interest in improving raincode. This document explains what the
repository contains, what you need before you start, how to build and test, and
how to prepare a change for review.

## What this repository is

This is one monorepo that ships the model layer of DeepSeek Harness (dsh) in two
halves:

| Half | Language | Role |
|---|---|---|
| `packages/` | TypeScript | the dsh plugins — translate dsh's `GenerateOptions` into the OpenAI wire format, stream chunks back, auto-spawn the gateway |
| `crates/` | Rust | the raincode gateway — model pool, prompt caching, retries/failover, skill network, capability refresh |

The plugins are the "mouth"; the gateway is the "brain". The plugins hold no
model logic. The TypeScript workspace covers `packages/core`,
`packages/plugin-skill` and `packages/plugin-routing`; the Rust gateway is a
workspace under `crates/` (`rc-pro`, `rc-profile`, `rc-gateway`,
`rc-capability`, `rc-skill`, `rc-state`, `rc-cli`).

## Prerequisites

- Rust `>= 1.75`
- Node.js `>= 22` (only if you want to develop the plugins)

## Build and test

TypeScript plugins:

```bash
npm install            # links @raincode-dsh/core into each plugin via workspaces
npm run build          # builds core, plugin-skill, plugin-routing
npm test               # runs every package's vitest suite
npm run typecheck      # type-checks every workspace package
```

Rust gateway:

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Release binary:

```bash
npm run backend:build  # or: cargo build --release
```

## Change discipline

- **Read the file before editing it.** Understand the existing code and any
  changes already in the working tree instead of guessing.
- **Keep commits small and focused.** Do not reformat or churn files unrelated
  to the change; keep edits scoped to the modules the change is about.
- **Add or update tests with each behavior change.** A change in behavior
  without matching test coverage is not ready for review.
- **Run the relevant build and tests before opening a PR** — `npm run build`,
  `npm test` and `npm run typecheck` for plugin changes;
  `cargo test --workspace` and
  `cargo clippy --workspace --all-targets -- -D warnings` for gateway changes.

## Where docs live

| Path | Contents |
|---|---|
| `docs/superpowers/specs/` | design documents for the gateway and the plugins |
| `docs/superpowers/plans/` | implementation plans (for example the capability-score enrichment plan behind `tools/enrich_models.py`) |
| `handoff/` | handoff notes and project history, including the post-mortem of the earlier multi-agent refactor attempt |
| `skills/` | `SKILL.md` playbooks shipped with the skill network |
| `agents/` | role prompts for dsh subagents (architect / coding / researcher) |

When you change a design or add a capability, record the reasoning in
`docs/superpowers/specs/` and the step-by-step work in `docs/superpowers/plans/`.
Each plugin also has its own README (English + 中文) covering prerequisites,
configuration fields and the tools it provides.

## Plugin packaging note

The packages are published independently to npm: `dsh-plugins-raincode-skill`,
`dsh-plugins-raincode-routing`, and `@raincode-dsh/core` — the shared adapter
core, published so the two plugins can resolve it independently. The Rust
binary is `raincode`, installed with `cargo install --path crates/rc-cli` (or
`./install.sh` / `install.ps1`).

## License

MIT
