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

The `raincode` model provider/adapter is registered by `dsh-plugins-raincode-routing`;
this plugin only adds the skill network, so both can be installed together without a
duplicate-provider conflict.

## Prerequisites

1. A **raincode gateway** (Rust) that implements `/skills` and `/learn`, reachable at
   the configured `baseURL` (default `http://127.0.0.1:8787`).
2. dsh `>= 0.2.2-rc.1`.
3. For auto-spawn, a `raincode` binary discoverable via `gatewayBin` / `RAINCODE_BIN` /
   repo `target/release` / `~/.raincode/bin` / `PATH`.
3. Optionally configure raincode profiles with `raincode setup`.

## Install in dsh

Requires dsh `>= 0.2.2-rc.1`. In a checkout:

```bash
dsh plugin --profile my-profile add "link:$PWD"
```

The package ships `cordis.patch.yml` (declared via `dsh.bundle.patch`), so the loader
row is inserted automatically; verify with
`dsh --profile my-profile --dump-config`.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode gateway address |
| `spawnGateway` | `true` | auto-start `raincode proxy` when a skill call needs it |
| `gatewayBin` | auto-detected | gateway executable; empty = detect via `RAINCODE_BIN` / repo build / `~/.raincode/bin` / `PATH` |

## License

MIT