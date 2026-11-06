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

`raincode` 模型 provider/适配器由 `dsh-plugins-raincode-routing` 注册;本插件只提供技能网络,
两个插件同装不会重复声明 provider。

## 前置条件

1. 一个实现 `/skills` 和 `/learn` 的 **raincode 网关**(Rust),可达于 `baseURL`(默认
   `http://127.0.0.1:8787`)。
2. dsh `>= 0.2.2-rc.1`。
3. 想自动拉起网关时,`raincode` 二进制需能被找到:`gatewayBin` / `RAINCODE_BIN` / 仓库
   `target/release` / `~/.raincode/bin` / `PATH`。
3. 可选:用 `raincode setup` 配置模型池。

## dsh 安装

需要 dsh `>= 0.2.2-rc.1`。在仓库中:

```bash
dsh plugin --profile my-profile add "link:$PWD"
```

包自带 `cordis.patch.yml`(通过 `dsh.bundle.patch` 声明),loader 行会自动插入;
可用 `dsh --profile my-profile --dump-config` 校验。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode 网关地址 |
| `spawnGateway` | `true` | 技能调用需要时自动启动 `raincode proxy` |
| `gatewayBin` | 自动探测 | 网关可执行文件;留空时按 `RAINCODE_BIN` / 仓库构建 / `~/.raincode/bin` / `PATH` 查找 |

## License

MIT