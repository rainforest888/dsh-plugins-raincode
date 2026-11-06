# Similar dsh plugins and how raincode compares

Snapshot date: **2026-11-06**. Names, stars and versions come from the npm
`dsh-plugin-catalog` package (`2026.1106.16122`, 9,111 entries / 23 categories),
the GitHub `dsh-plugin` topic (27,562 repositories) and the plugins' own npm
manifests. Stars move fast; treat them as a scale indicator, not a ranking.

The catalog has **no** entry or command named `raincode`, so the name is free.

## The short version

raincode is a **local multi-provider gateway with a Rust core**, wrapped in two
small dsh plugins. Other dsh plugins route model *names* inside dsh; raincode owns
the *wire*: an OpenAI-compatible gateway that pools providers, caches prefixes,
retries/fails over, scores model capability, and indexes skills as a DAG. If you
only want "pick a cheaper model for small steps", a pure-JS router is lighter. If
you want caching + failover + cross-provider pooling that also serves other clients
(scripts, other agents), raincode is the different shape.

## Directly comparable: model routing

| Plugin | Stars | Shape | Overlap with raincode |
|---|---|---|---|
| [`Alice-Marx/dsh-model-router`](https://github.com/Alice-Marx/dsh-model-router) | 822 | Model router + GALGame, JS plugin | Same "route by task" goal; no gateway, no pooling |
| [`yjh051108/dsh-routing-suite`](https://github.com/yjh051108/dsh-routing-suite) | 7,000 | Injector + `router-standard`, JS plugin | Broad routing suite; dsh-internal only |
| [`dsh-router-laya`](https://github.com/hairyf/dsh-router-laya) | 30 | Local ModernBERT classifier picks thinking effort, ships a 842 MB model | Closest in spirit (local routing); very heavy install, no gateway |
| `kimi-tide` | 7 | Step routing with image/keyword rules | Rule-based routing; no cache/failover |
| `dsh-dual-auto` | 1 | Auto upgrade/downgrade between two models | Narrow two-model switching |
| `dsh-model-router-en` | 1 | English fork of a router | Duplicate of the above |
| [`DSH-GOD`](https://github.com/hanshuaikang/dsh-god) | 39 | Routing + provider panel UI | Provider management overlaps partially |
| `dsh-agent-preset-router`, `dsh-subagent-role-router` | — | Route by agent preset / subagent role | Overlaps with `raincode_route`'s subagent dispatch |

**Difference:** these pick a model inside dsh and call the provider directly. raincode
takes over the `raincode` provider, translates dsh's message model to the OpenAI wire
format, and forwards to a local gateway that holds the pool, cache and retry policy.
Routing decisions can therefore survive across sessions and clients, and the gateway
can serve tools that know nothing about dsh.

## Adjacent: gateways and account pools

| Plugin | Stars | Shape | Relation |
|---|---|---|---|
| [`wink-run/tokenbank`](https://github.com/wink-run/tokenbank) | 111 | "Local LLM gateway between agents and every provider" | The most similar *architecture* (HTTP gateway). No Rust core, no capability scoring, no skill network |
| `dsh-xdpool` | 436 | WorkBuddy account-pool failover | Account pooling: overlaps with raincode's profile pool, but web-account oriented |
| `dsh-llm-api-pool` | — | API-key pool with rotation | Overlaps with `rc-profile` key handling |
| `dsh-free-models-hub` | 34 | Free-model catalog | Data source, not a gateway |
| `dsh-opencode-routing` | 2.6.0 | opencode account rotation | Narrower (single vendor) |
| `dsh-multi-chat` | — | Multi-model chat | UI-level, not a routing layer |

**Difference:** tokenbank/xdpool proxy traffic too, but they are JavaScript and
focused on credentials/rotation. raincode adds prompt caching (`rc-pro`), provider
failover, capability refresh from public leaderboards, and a skill network that the
gateway also serves (`/skills/*`).

## Adjacent: self-evolution and skills

| Plugin | Stars | Shape | Relation |
|---|---|---|---|
| `dsh-self-evolving` | 8 | Evidence-first self-evolution controller | Same "learn from sessions" idea; raincode stores distilled skills as `SKILL.md` in a DAG |
| `dsh-self-improved` | 15 | L0–L3 memory self-evolution | Memory tiers; raincode is skill-file based |
| `dsh-auto-evolve` | 5 | Auto evolution loop | Overlap with `raincode_learn` |
| `dsh-plugin-zerone` | 2 | 16 SDD workflow skills | Skills-as-prompt-pack; no DAG/router/index |
| `ReMe` | 3,754 | Memory framework | Much larger memory system; not dsh-specific |

**Difference:** raincode indexes skills as an empty-body DAG that drills down to
short leaf checklists, and `raincode_learn` distills a session into a review-gated
`SKILL.md`. The skills are served by the same gateway, so non-dsh clients can use
them too.

## When to choose something else

- You want a single-file JS plugin with zero runtime dependencies, no binary:
  `dsh-model-router`, `kimi-tide` or `dsh-dual-auto` are simpler.
- You only need account rotation for one provider: `dsh-opencode-routing` or
  `dsh-xdpool` do that without a gateway.
- You need a memory framework far beyond skill files: `ReMe` or `dsh-self-improved`.
- You want a classifier that ships its own local model and never calls out:
  `dsh-router-laya` (at ~842 MB install cost).

## When raincode is the better fit

- You route across **several providers** and want one OpenAI-compatible endpoint
  for dsh *and* for scripts/other agents.
- You care about **prompt-cache hit rate, retries and failover**, not just model choice.
- You want **capability evidence** (leaderboard refresh, per-model scores) to drive
  routing rather than hand-written rules.
- You want a **skill network** that the same gateway serves to any client.
- You are fine with a Rust binary (built locally, auto-detected by the plugin).

## References

- npm: `dsh-plugin-catalog@2026.1106.16122` (9,111 plugin entries).
- GitHub topic `dsh-plugin`: 27,562 repositories at snapshot time.
- Individual plugin pages linked above; star counts read on 2026-11-06.
- The plugins' own `package.json` and `cordis.patch.yml` for install shape.

This comparison is a positioning aid, not a benchmark. Numbers were not re-measured;
no head-to-head latency or cache-hit tests exist yet.
