# dsh-plugins-raincode-skill

**Skill self-evolution network** inside DeepSeek Harness (dsh). Browse, search, and
load the raincode skill library, and distill your experience into a new `SKILL.md`
(reviewed before activation). The plugin is the "mouth" — it talks to the raincode
gateway; the gateway (Rust) owns the skill store and evolution logic.

This is one of the two raincode plugins split from the monorepo. The other one,
`dsh-plugins-raincode-routing`, handles model auto-routing.

## What you get

| Tool / command | When |
|---|---|
| `/skills` (command) | List all raincode skills, or `/skills <name>` to view a body |
| `raincode_skill_search` | Search the skill network by keyword (name/description/category/tags/body) |
| `raincode_skill_load` | Load a skill's full body by exact name |
| `raincode_learn` | Distill the current session into a SKILL.md (goes to the review area; you approve before it's active) |
| `raincode_status` | Query recent model calls / cached capability profiles / model-pool profiles (skill side) |

The plugin also registers a `raincode` model provider so you can select a raincode
pool model to talk to while browsing skills.

## Prerequisites

1. A **raincode gateway** (Rust) that implements `/skills` and `/learn`, reachable at
   the configured `baseURL` (default `http://127.0.0.1:8787`).
2. `raincode` available on `PATH` (or `RAINCODE_BIN`) if you want the plugin to
   auto-spawn the gateway (`spawnGateway: true`).
3. Optionally configure raincode profiles with `raincode setup`.

## Install in dsh

```bash
dsh plugin --profile web add dsh-plugins-raincode-skill
```

Then add a row to the profile's patch layer and set its `baseURL` to your raincode
gateway. Restart `dsh web` to load it.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode gateway address |
| `apiKeyEnv` | `RAINCODE_API_KEY` | dsh credential seam only; a loopback gateway does not verify keys |
| `spawnGateway` | `true` | auto-start `raincode proxy` on plugin load |
| `gatewayBin` | `RAINCODE_BIN` / `raincode` | executable used to spawn the gateway |
| `streamIdleTimeoutMs` | `300000` | stream idle timeout |
| `retryPolicy` | dsh default | retry policy for model calls |

## License

MIT