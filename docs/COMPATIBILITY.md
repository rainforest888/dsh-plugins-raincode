# DSH compatibility

This document records the DeepSeek Harness (dsh) API surface the plugins are built
against, what changed in `0.2.2`, and how each change was adapted. It is the
reference for re-validating the plugins after a dsh upgrade.

## Supported versions

| Component | Supported | Notes |
|---|---|---|
| dsh | `>= 0.2.2-rc.1` | verified against desktop `0.2.2-rc.1`; both `desktop` and `web` profiles use the same plugin API |
| Node.js | `>= 22.19.0` | declared in each plugin's `engines`; the optional `chunked-list` peer pushes this floor up |
| cordis | `~4.1.0` | peer dependency of `dsh-llm` / `dsh-settings` in 0.2.2 |
| schemastery | `^3.19.0` | `volatile()` sugar plus `extra('volatile', true)` fallback |
| Rust | `>= 1.75` | gateway (`crates/`) only; irrelevant when a gateway already runs elsewhere |

The plugins declare `dsh.compatibility.dshReleases = { "0.2.2-rc.1+": "compatible" }`
in their `package.json`, so a dsh host can gate loading to known-good releases.

## What changed in dsh 0.2.2, and the adaptation

### Settings: `installSettingsSection` is gone

`dsh-settings` 0.2.2 replaced the old settings-section helper with the
`SettingsForms` service (`ctx.settings`):

- `describe()`, `update(ns, patch, expectedRevision?)`, `replace`, `mutate`
- a single event, `settings/document-updated` (the old `settings/updated` no longer exists)
- `installSettingsSection`, `settingsNamespace` and `deepEqualJson` were removed

In 0.2.2 the `config` object passed to `apply(ctx, config)` **is** the settings
section for the plugin's loader entry: each field marked volatile arrives as a
live `cosmokit` `Volatile { get() }` reference. Editing the value in the dsh
settings UI updates it in place — the plugin never has to re-mount.

Adaptation:

- every configurable field is `.default(...)`-ed and wrapped in `volatileField()`
  (which uses `schema.volatile()` when available, else `schema.extra('volatile', true)`);
- the plugins call `readLiveConfig(rawConfig)` on every use, which unwraps nested
  `Volatile` references and re-reads them, so settings changes take effect on the
  next request without a reload;
- the settings namespace is the **loader entry id**, resolved at apply time from
  `ctx.get('loader').entries()` (`resolveSettingsNamespace`), with the npm package
  name as the fallback;
- no `settings/updated` listener is needed — the existing per-request reads are the
  synchronization point.

### Subagents: `start(provider, request)` → `startActivation(spec)`

`dsh-subagent` 0.2.2 exposes `SubagentRuntime.startActivation(spec)`, returning a
`SubagentActivation` (`childId`, `messageId?`, `result: Promise<SubagentResult>`,
`dispose()`), instead of the old `start()` returning a run handle. The activation
spec separates the routing fields (`provider`, `delivery`, `signal`) from the
request (`label`, `prompt`, `parent`, `agentOptions`, `maxDepth`).

Adaptation: `raincode_route` calls `startActivation({ provider, label, delivery:
'caller', signal, request: { prompt, parent, agentOptions, maxDepth } })`, awaits
`activation.result` and always `dispose()`s it in `finally`.

### Messages: tool results are messages, not content blocks

`dsh-llm` 0.2.2 removed the `tool-result` content block and the `CallId` brand:

- tool results are standalone `{ role: 'tool', toolCallId, content, isError? }` messages;
- `ToolCallBlock.id` is a `ToolCallId` brand;
- `ContentBlockMap` is `text | reasoning | image | file | tool-call | tool-addition | tool-removal`;
- `GenerateOptions.messages` is `RequestMessage[]` (`Message | RequestUserInput`);
- developer messages carry tool add/remove deltas that callers project with
  `projectToolUpdates()` when a route supports dynamic tools.

Adaptation: `serialize.ts` switches on the message role (system / developer / user /
assistant / tool), emits a separate OpenAI `tool` message per tool result, drops
developer messages (raincode always sends a complete tool snapshot, so the deltas
carry no information for it), and rejects image content with a clear error. Tests
cover each branch.

### LLM adapter registration

`LlmAdapter` in 0.2.2 has a single abstract member, `stream(options)`; the rest
(`providerInfo`, `providerRetryPolicy`, `listModels`, `resolveModel`, …) are
concrete with sensible defaults. `registerAdapter()` returns an
`AdapterRegistrationHandle` that can `replace()` its provider list.

Adaptation: `RaincodeAdapter` already overridden exactly those members, so
`adapter.ts` needed no changes. The routing plugin is the only plugin that
registers the `raincode` provider/adapter — the skill plugin no longer does, which
avoids a duplicate-provider error when both are installed.

### Tools and commands

- `ToolDefinition` requires `output: { schema, render(args, value) }` — the tool
  definitions already had it.
- `CommandDefinition` / `CommandInvocation` / `CommandResult` are unchanged; the
  `/skills` command is compatible as-is.

### Model selection

`agent-default-model` is not a settings namespace in 0.2.2 (model choice is a
per-session projection). `readDshCurrentModel()` is therefore a best-effort probe:
it scans the settings descriptors for an `agent-default-model`-suffixed section and
returns `undefined` on 0.2.2. Routing falls back to `mainModel` → the `role: main`
profile. The plugin works without the probe; it no longer depends on it.

## Loading: bundle patches

Each plugin ships `cordis.patch.yml` at the package root and declares it in
`package.json`:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

The patch inserts one loader row whose `id` equals the package name:

```yaml
- insert:
    - id: dsh-plugins-raincode-routing
      name: dsh-plugins-raincode-routing
    - id: dsh-plugins-raincode-skill
      name: dsh-plugins-raincode-skill
```

Because the row `id` is the settings namespace, the settings UI shows the sections
under those ids.

## Verification performed

On dsh `0.2.2-rc.1` (desktop profile, Node 24.21.0):

- `npm run typecheck` — no errors in any workspace package.
- `npm test` — 53 tests pass (core 29, plugin-routing 14, plugin-skill 10).
- `dsh plugin --profile rc-test add "link:<repo>/packages/plugin-routing"
  "link:<repo>/packages/plugin-skill"` installs into a throwaway profile.
- `dsh --profile rc-test --dump-config` lists the two loader entries with the
  expected ids, and a bare `import('dsh-plugins-raincode-routing')` from the
  profile directory resolves every peer dependency.
- Gateway binary discovery, loopback detection and the plugin registry path are
  covered by unit tests (`packages/core/src/gateway.spec.ts`).

Not covered by automated tests: launching the Electron app end to end. `dsh
<app>` starts the GUI and blocks, so validation is done through `--dump-config`,
module import, and unit tests instead.

## Re-validating after a dsh upgrade

1. `npm view @deepseek-ai/dsh-llm version` and compare the `LlmAdapter`,
   `SubagentRuntime`, `SettingsForms`, `ToolDefinition`, `CommandDefinition` d.ts
   files against `docs/COMPATIBILITY.md`.
2. Run `npm run typecheck && npm test`.
3. Install into a throwaway profile (`dsh plugin --profile <tmp> add ...`) and run
   `--dump-config`.
4. If the settings or subagent seams changed, update `packages/core/src/live.ts`
   and `packages/plugin-routing/src/route.ts` first — everything else builds on them.
