# dsh-plugins-raincode-skill

**skill 自进化网络**——在 DeepSeek Harness(dsh) 内浏览、搜索、加载 raincode 技能库，
并把本次经验沉淀为新的 `SKILL.md`(先入 review 区,你确认后才转正)。插件是"嘴",
与 raincode 网关对话;网关(Rust)持有技能库与进化逻辑。

这是 raincode 从 monorepo 拆出的两个插件之一;另一个 `dsh-plugins-raincode-routing`
负责模型自动路由。

## 能力

| 工具 / 命令 | 何时用 |
|---|---|
| `/skills`(命令) | 列出全部 raincode 技能,或 `/skills <名字>` 查看正文 |
| `raincode_skill_search` | 按关键词搜索技能网络(名字/描述/分类/标签/正文) |
| `raincode_skill_load` | 按精确名字加载技能正文 |
| `raincode_learn` | 把本次会话沉淀为 SKILL.md(进 review 区,你确认后激活) |
| `raincode_status` | 查询最近调用 / 缓存能力档案 / 模型池(skill 侧) |

插件还注册一个 `raincode` 模型 provider,让你在浏览技能时也能选 raincode 模型池对话。

## 前置条件

1. 一个实现 `/skills` 和 `/learn` 的 **raincode 网关**(Rust),可达于 `baseURL`(默认
   `http://127.0.0.1:8787`)。
2. 想自动拉起网关(`spawnGateway: true`)的话,`raincode` 需在 `PATH` 或设 `RAINCODE_BIN`。
3. 可选:用 `raincode setup` 配置模型池。

## dsh 安装

```bash
dsh plugin --profile web add dsh-plugins-raincode-skill
```

然后在 profile 的 patch 层加一行并把 `baseURL` 指向你的 raincode 网关,重启 `dsh web` 生效。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode 网关地址 |
| `apiKeyEnv` | `RAINCODE_API_KEY` | 仅 dsh 凭据通道;回环网关不校验 key |
| `spawnGateway` | `true` | 插件加载时自动启动 `raincode proxy` |
| `gatewayBin` | `RAINCODE_BIN` / `raincode` | 拉起网关用的可执行文件 |
| `streamIdleTimeoutMs` | `300000` | 流式空闲超时 |
| `retryPolicy` | dsh 默认 | 模型调用重试策略 |

## License

MIT