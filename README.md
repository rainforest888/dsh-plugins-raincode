# dsh-raincode

Make **raincode** the model layer of **DeepSeek Harness (dsh)**: a cheap model pool
with StablePrefix prompt caching, retries and failover, driven by a local
OpenAI-compatible gateway (Rust).

This repository is the **dsh plugin monorepo** for raincode. It ships that
capability as two independently publishable dsh plugins that share the adapter
core in `packages/core`.

## Packages

| Package | Focus | Tools / Commands |
|---|---|---|
| [`dsh-plugins-raincode-skill`](./packages/plugin-skill) | Skill self-evolution network — browse / search / load raincode skills and distill experience into `SKILL.md` | `/skills`, `raincode_skill_search`, `raincode_skill_load`, `raincode_learn`, `raincode_status` |
| [`dsh-plugins-raincode-routing`](./packages/plugin-routing) | Model auto-routing — a strong main model decomposes a large task and dispatches cheaper subagents by direction | `raincode_route`, `raincode_agent_tree`, `raincode_refresh_model`, `raincode_status` |
| [`@raincode-dsh/core`](./packages/core) | Shared adapter core (OpenAI wire serialization, SSE translation, gateway auto-spawn); published so the two plugins can resolve it independently | — |

## Architecture

The plugins are the "mouth": they translate dsh's `GenerateOptions` into the
OpenAI wire format and stream chunks back. The raincode gateway (Rust) is the
"brain": it owns profile selection, prompt caching, retries and failover. The
plugins hold no model logic.

## Layout

```
packages/
  core/            shared adapter core (adapter, serialize, translate, sse, gateway manager)
  plugin-skill/    dsh-plugins-raincode-skill
  plugin-routing/  dsh-plugins-raincode-routing
```

## Quick start

1. Install the raincode CLI (`>= 0.1.0`):
   `cargo install --path crates/rc-cli` (or use `./install.sh`).
2. Configure your model pool: `raincode setup` (writes `~/.raincode/profiles.toml`).
3. Start the gateway: `raincode proxy --port 8787`, then verify
   `curl http://127.0.0.1:8787/health` → `{"ok":true,"service":"raincode-gateway"}`.

## Install in dsh

```bash
dsh plugin --profile web add dsh-plugins-raincode-skill
dsh plugin --profile web add dsh-plugins-raincode-routing
```

Then add a row for each plugin to the profile's patch layer
(`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: raincode-skill
      name: dsh-plugins-raincode-skill
      config:
        baseURL: http://127.0.0.1:8787
        apiKeyEnv: RAINCODE_API_KEY
    - id: raincode-routing
      name: dsh-plugins-raincode-routing
      config:
        baseURL: http://127.0.0.1:8787
        apiKeyEnv: RAINCODE_API_KEY
```

Restart `dsh web` to load them. Each plugin has its own README (English + 中文)
covering prerequisites, installation, configuration fields and the tools it
provides.

## Development

```bash
npm install            # links @raincode-dsh/core into each plugin via workspaces
npm run build          # builds core, plugin-skill, plugin-routing
npm test               # runs every package's vitest suite
```

## License

MIT
