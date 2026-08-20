# dsh-plugins-raincode (monorepo)

Make **raincode** the model layer of **DeepSeek Harness (dsh)**: a cheap model pool
with StablePrefix prompt caching, retries, and failover, driven by a local
OpenAI-compatible gateway.

This monorepo splits that capability into **two independently publishable dsh
plugins**, sharing the adapter core in `packages/core`.

## Packages

| Package | Focus | Tools / Commands |
|---|---|---|
| [`dsh-plugins-raincode-skill`](./packages/plugin-skill) | **skill 自进化网络** — browse / search / load raincode skills and distill experience into SKILL.md | `/skills`, `raincode_skill_search`, `raincode_skill_load`, `raincode_learn` |
| [`dsh-plugins-raincode-routing`](./packages/plugin-routing) | **模型自动路由** — orchestrates a strong main model that dispatches cheaper subagents by direction | `raincode_route`, `raincode_agent_tree`, `raincode_refresh_model`, `raincode_status` |
| [`@raincode-dsh/core`](./packages/core) | shared adapter (OpenAI wire serialization, SSE translate, gateway auto-spawn) — published so the two plugins can resolve it independently | — |

## Layout

```
packages/
  core/            shared adapter core (adapter, serialize, translate, sse, gateway manager)
  plugin-skill/    dsh-plugins-raincode-skill
  plugin-routing/  dsh-plugins-raincode-routing
```

## Development

```bash
npm install            # links @raincode-dsh/core into each plugin via workspaces
npm run build          # builds core, plugin-skill, plugin-routing
npm test               # runs every package's vitest suite
```

Each plugin has its own README (English + 中文) explaining prerequisites,
dsh installation, configuration, and the tools it provides.

## License

MIT