# @raincode-dsh/core

Shared adapter core for the raincode dsh plugins. This package is **not** published
standalone — it is a workspace dependency used by `dsh-plugins-raincode-skill` and
`dsh-plugins-raincode-routing`.

## Contents

- `RaincodeAdapter` — the dsh `LlmAdapter` for the raincode gateway (OpenAI wire,
  SSE streaming, retry policy, model catalog via `/v1/models`).
- `serializeRequest` / `translate` / `parseSse` — GenerateOptions → OpenAI chat body,
  SSE → StreamChunk, SSE parsing.
- `createGatewayManager` + registry helpers — auto-spawn `raincode proxy`, health
  wait, profile registry TOML writing, `PUT /profiles` sync, kill on dispose.

Imports from `@raincode-dsh/core`:

```ts
import { RaincodeAdapter, createGatewayManager, writeRegistry, type RaincodeProfile } from '@raincode-dsh/core'
```

## License

MIT