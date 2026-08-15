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

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode gateway address |
| `apiKeyEnv` | `RAINCODE_API_KEY` | dsh credential seam only; a loopback gateway does not verify keys (missing credentials don't block it) |
| `models` | `[]` | optional static catalog override; empty fetches the pool from the gateway's `/v1/models` |
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
