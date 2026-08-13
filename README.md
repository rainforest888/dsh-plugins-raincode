# dsh-plugins-raincode

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
npm i dsh-plugins-raincode
```

Add the plugin to your dsh `cordis.yml`:

```yaml
- id: raincode
  name: dsh-plugins-raincode
  config:
    baseURL: http://127.0.0.1:8787
    apiKeyEnv: RAINCODE_API_KEY
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode gateway address |
| `apiKeyEnv` | `RAINCODE_API_KEY` | dsh credential seam only; the local gateway does not verify keys |
| `models` | `[]` | optional static catalog override; the pool is served by the gateway |
| `streamIdleTimeoutMs` | `300000` | stream idle timeout |
| `retryPolicy` | dsh default | retry policy via `RetryPolicySchema` |

## What you get

- **Model selection** — dsh's model picker shows the raincode pool
  (`/v1/models`); the chosen model maps exactly to a gateway profile.
- **`/skills` browsing** — run `/skills` to list the raincode skill library,
  `/skills <name>` to read a skill's body. Data comes from the gateway's
  `/skills` endpoint (`~/.raincode/skills/`).
- **Caching & retries** — prompt caching and retry/failover are handled by the
  gateway per profile; nothing to configure in dsh.

## FAQ

- **Gateway not running?** You'll see `TRANSPORT`-style errors from the model
  call. Start it with `raincode proxy --port 8787`.
- **Why is the API key a formality?** The local gateway trusts loopback and
  resolves the real upstream keys from `~/.raincode/profiles.toml`. Export
  `RAINCODE_API_KEY` only to satisfy the dsh credential seam.
- **How do I add a model?** `raincode setup` (or edit `~/.raincode/profiles.toml`
  and restart the gateway).

## License

MIT
