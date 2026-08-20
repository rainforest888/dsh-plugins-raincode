# dsh-plugins-raincode-routing

**Model auto-routing** inside DeepSeek Harness (dsh). `raincode_route` starts a
strong main model (through dsh's native subagent seam) that decomposes a large task
and dispatches cheaper subagents by direction. The plugin is the "mouth" — it talks
to the raincode gateway; the gateway (Rust) owns model-pool selection, capability
profiles, and routing.

This is one of the two raincode plugins split from the monorepo. The other one,
`dsh-plugins-raincode-skill`, handles the skill self-evolution network.

## What you get

| Tool | When |
|---|---|
| `raincode_route` | User explicitly asks, or the task is clearly large (multi-module / multi-direction / long-running) — chat asks first. Do not call for small tasks |
| `raincode_agent_tree` | User asks which subagent launched which grand-subagents (renders the dsh delegation tree) |
| `raincode_refresh_model` | User says "check the capability of model X" |
| `raincode_status` | User asks for raincode status / subagent work / token usage (routing & pool side) |

`raincode_route` flow: the chat model calls the tool → the plugin starts a one-shot
subagent through dsh `subagents.start` using the raincode main model (`mainModel`);
that main agent then dispatches subagents/grand-subagents through dsh's native
subagent tools. Delegation depth is capped by `maxDepth`.

The plugin also registers a `raincode` provider and can take over dsh's current chat
model, mapping it to a matching raincode pool profile.

## Prerequisites

1. A **raincode gateway** (Rust) implementing `/v1/models`, `PUT /profiles`, and
   `/capabilities/refresh`, reachable at the configured `baseURL`.
2. `raincode` available on `PATH` (or `RAINCODE_BIN`) for gateway auto-spawn.
3. Your dsh profile/preset must enable the `subagent` tool (provider `spawn`) and the
   `subagent-spawn-in-process` provider, otherwise `raincode_route` cannot start agents.

## Install in dsh

```bash
dsh plugin --profile web add dsh-plugins-raincode-routing
```

Add a row to the profile's patch layer and point `baseURL` at your raincode gateway.
Restart `dsh web` to load it.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode gateway address |
| `profiles` | `[]` | model pool; each profile can set `role: main/subagent/any` |
| `mainModel` | empty | raincode main model for `raincode_route`; auto-picks a `role=main` profile, else the dsh current model |
| `subagentProvider` | `spawn` | dsh subagent provider name |
| `maxDepth` | `3` | max delegation depth for `raincode_route` |
| `spawnGateway` | `true` | auto-start `raincode proxy` on load |
| `gatewayBin` | `RAINCODE_BIN` / `raincode` | gateway executable for auto-spawn |
| `streamIdleTimeoutMs` | `300000` | stream idle timeout |
| `retryPolicy` | dsh default | retry policy for model calls |

## License

MIT