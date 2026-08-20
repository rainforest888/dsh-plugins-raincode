# dsh-plugins-raincode (monorepo)

让 **raincode** 成为 **DeepSeek Harness (dsh)** 的模型层：低价模型池 + StablePrefix
prompt 缓存 + 重试/故障转移，由本地 OpenAI 兼容网关驱动。

本 monorepo 把该能力拆成**两个独立发布**的 dsh 插件，共享 `packages/core` 适配核心。

## 包一览

| 包 | 定位 | 工具 / 命令 |
|---|---|---|
| [`dsh-plugins-raincode-skill`](./packages/plugin-skill) | **skill 自进化网络**——浏览 / 搜索 / 加载 raincode 技能，并把经验沉淀为 SKILL.md | `/skills`、`raincode_skill_search`、`raincode_skill_load`、`raincode_learn` |
| [`dsh-plugins-raincode-routing`](./packages/plugin-routing) | **模型自动路由**——用强主控模型按方向派发低价子代理 | `raincode_route`、`raincode_agent_tree`、`raincode_refresh_model`、`raincode_status` |
| [`@raincode-dsh/core`](./packages/core) | 共享适配核心（OpenAI wire 序列化、SSE 翻译、网关自动拉起）——发布供两个插件独立解析 | — |

## 目录

```
packages/
  core/            共享适配核心（adapter、serialize、translate、sse、gateway manager）
  plugin-skill/    dsh-plugins-raincode-skill
  plugin-routing/  dsh-plugins-raincode-routing
```

## 开发

```bash
npm install            # 通过 workspaces 把 @raincode-dsh/core 链进每个插件
npm run build          # 依次构建 core、plugin-skill、plugin-routing
npm test               # 运行每个包的 vitest 套件
```

每个插件有自己的 README（中英）说明前置条件、dsh 安装、配置与工具。

## License

MIT