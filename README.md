# dsh-raincode

Make **raincode** the model layer of **DeepSeek Harness (dsh)**: a cheap model pool
with StablePrefix prompt caching, retries, and failover, driven by a local
OpenAI-compatible gateway. Inside dsh you can pick any model from your raincode
pool and browse the raincode skill library with `/skills`.

The plugin is the "mouth" — it translates dsh's `GenerateOptions` to the OpenAI
wire format and streams chunks back — while the raincode gateway (Rust) is the
"brain" that owns profile selection, caching, and retries. The plugin holds no
model logic.

## Prerequisites

1. **Install raincode** (`>= 0.1.0` with gateway `/v1/models` and `/skills`):

   ```bash
   cd raincode
   cargo install --path crates/rc-cli
   # or use ./install.sh
   ```

2. **Configure profiles** (your model pool):

   ```bash
   raincode setup
   # writes ~/.raincode/profiles.toml
   ```

3. **Start the gateway** (keep it running):

   ```bash
   raincode proxy --port 8787
   ```

   Verify: `curl http://127.0.0.1:8787/health` → `{"ok":true,"service":"raincode-gateway"}`.

## Required dsh subagent plugins

`raincode_route` depends on the dsh **subagent seam**. Your dsh profile/preset must have:

- the model-facing `subagent` tool (from `@deepseek-ai/dsh-tool-subagent`, provider name `spawn`);
- the matching provider (`@deepseek-ai/dsh-subagent-spawn-in-process`, registered as `spawn`).

The standard DeepSeek Harness preset ships these rows; a custom preset needs at least:
- `tool-subagent` (provider: spawn)
- `subagent-spawn-in-process`

Without them the raincode plugin cannot load (it injects `subagents` explicitly).

## Install in dsh

```bash
dsh plugin --profile web add dsh-plugins-raincode
```

Then add the row to the profile's patch layer
(`~/.dsh/profiles/web/cordis.patch.yml`, or `~/.dsh/cordis.patch.yml` for every
profile):

```yaml
- insert:
    - id: raincode
      name: dsh-plugins-raincode
      config:
        baseURL: http://127.0.0.1:8787
        apiKeyEnv: RAINCODE_API_KEY
```

`dsh --profile web --dump-config` should show the raincode row; restart
`dsh web` to load it.

## Tools

| Tool | When |
|---|---|
| `raincode_route` | User explicitly asks, or the task is clearly large (multi-module/multi-direction/long-running) — chat asks the user first. Do not call for small tasks |
| `raincode_agent_tree` | User asks which subagent launched which grand-subagents |
| `raincode_refresh_model` | User says "check the capability of model X" |
| `raincode_learn` | User says "learn this task / distill it into a skill" |
| `raincode_status` | User asks for raincode status / subagent work / token usage |
| `raincode_skill_search` / `raincode_skill_load` | Use the raincode skill network |

`raincode_route` flow: chat calls the tool → the plugin starts a one-shot subagent through dsh `subagents.start`, using the raincode main model (`mainModel`); that main agent then dispatches subagents/grand-subagents through dsh's native subagent tools.

Grand-subagent UI follows the native dsh subagent experience: the Web UI session-header subagent catalog expands level by level (parent → child → grandchild), each row shows its direct descendant count, and clicking any depth opens that child. raincode keeps every level on the native dsh subagent seam, so parent-child relations and display are maintained by dsh itself.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode gateway address |
| `apiKeyEnv` | `RAINCODE_API_KEY` | dsh credential seam only; a loopback gateway does not verify keys (missing credentials don't block it) |
| `models` | `[]` | optional static catalog override; empty fetches the pool from the gateway's `/v1/models` |
| `profiles` | `[]` | model pool; each profile can set `role: main/subagent/any` and direction `tags` |
| `mainModel` | empty | raincode main model; empty auto-picks a `role=main` profile, then falls back to the dsh current model |
| `subagentProvider` | `spawn` | dsh subagent provider name (must be registered) |
| `maxDepth` | `3` | maximum delegation depth for `raincode_route` (subagent → grand-subagent → great-grand-subagent) |
| `streamIdleTimeoutMs` | `300000` | stream idle timeout (dsh-timeout helper) |
| `retryPolicy` | dsh default | retry policy via `RetryPolicySchema` |

## What you get

- **Model selection** — dsh's model picker shows the raincode pool (fetched
  from the gateway's `/v1/models`); the chosen model maps exactly to a gateway
  profile.
- **`/skills` browsing** — run `/skills` to list the raincode skill library,
  `/skills <name>` to read a skill's body. Data comes from the gateway's
  `/skills` endpoint (`~/.raincode/skills/`).
- **Caching & retries** — prompt caching (`sessionId` → `prompt_cache_key`) and
  retry/failover are handled by the gateway per profile; nothing to configure
  in dsh.
- **Parallel tool calls** — tool calls stay separate blocks keyed by call
  index; fragmented arguments accumulate per call.

## FAQ

- **raincode_route unavailable?** Check that your profile/preset enables the `subagent` tool and the `spawn` provider (see Required dsh subagent plugins).

- **Gateway not running?** You'll see `TRANSPORT`-style errors from the model
  call. Start it with `raincode proxy --port 8787`.
- **Why is the API key a formality?** A loopback gateway trusts the machine and
  resolves real upstream keys from `~/.raincode/profiles.toml` (inline, key
  file, or env). The plugin only demands a credential when `baseURL` points at
  a remote gateway.
- **How do I add a model?** `raincode setup` (or edit `~/.raincode/profiles.toml`
  and restart the gateway).

## License

MIT

中文说明见 [README.zh.md](./README.zh.md).
