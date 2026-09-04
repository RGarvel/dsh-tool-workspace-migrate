# dsh-tool-workspace-migrate

[![npm version](https://img.shields.io/npm/v/@garvel/dsh-tool-workspace-migrate)](https://www.npmjs.com/package/@garvel/dsh-tool-workspace-migrate)

DSH 插件：工作区迁移，注册两个工具：

- `list_workspace_sessions` —— 列出某个共享目录下共用的会话；
- `migrate_workspace` —— 把多条会话**分别**迁到**不同**目标工作区。

包名 `@garvel/dsh-tool-workspace-migrate`，源码见
[GitHub](https://github.com/RGarvel/dsh-tool-workspace-migrate)。
兼容 dsh `^0.1.0-rc.8` 或 `>=0.1.1-rc.0 <0.2.0`。

## 核心行为

场景：多个对话共用一个工作区（同一目录），现在要拆到各自的工作区。工具对每个 `migrations` 条目做：

1. 读源会话（live 或 cold，经 `sessionPersistence.inspect`），得到它的 `cwd` 与完整事件日志。
2. 校验目标与源目录互不嵌套；`target_path` 不存在则新建。
3. 按 `copy_mode` 复制文件（**复制、不删源**）：
   - `full`（默认）：整目录快照复制——最安全，什么都不丢；
   - `artifacts`：只复制该会话经 `write`/`edit` 明确写/改过的文件；
   - `artifacts_read`：`write`/`edit` + `read` 触碰过的文件；
   - 之后再叠加 `extra_paths`（如 `node_modules`、`.git`、`.env`、某个 `config/`）。
4. 注册目标目录为工作区：已注册则复用，否则新建（标题 `title`）。
5. 若 `carry_context=true`（默认），以该会话完整历史为种子、`meta.cwd=目标目录` 新建会话（会话 cwd 不可改绑，故"继续"=新 sessionId）；失败会在 `continuation_error` 里报，但文件复制与登记已完成。
6. 若 `archive_source=true`（默认），归档源会话（只加 `archivedSessionIds` 标记，**不碰文件、不删日志**）。

## 工具参数

### `list_workspace_sessions`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 要列出的工作区目录绝对路径 |

返回每条会话的 `session_id`、标题（或首条用户消息）、`created_at`、`archived`。

### `migrate_workspace`

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `migrations` | array | 是 | — | 每个条目 `{ session_id, target_path, title? }` |
| `copy_mode` | `full`\|`artifacts`\|`artifacts_read` | 否 | `full` | 每个目标拿到多少文件 |
| `extra_paths` | string[] | 否 | `[]` | 相对源目录、始终追加的文件/子目录 |
| `carry_context` | boolean | 否 | `true` | 是否带历史种子在目标新建会话 |
| `archive_source` | boolean | 否 | `true` | 迁移后是否归档源会话 |
| `rebind_qq_channel` | boolean | 否 | `true` | 源会话绑定了 QQ 通道时，自动把通道改指到续接会话（见下节） |

返回 `results[]`：每条的 `ok`、`source_path`/`target_path`、`workspace_id`、`copied_files`/`skipped_files`、`continuation_session_id`/`continuation_error`、`archived`，发生过 QQ 改绑（或改绑失败）时另有 `qq_channel`。

## 安装

### 方式 A：从 npm 安装（推荐）

```powershell
dsh plugin --profile web add @garvel/dsh-tool-workspace-migrate
```

### 方式 B：从源码安装

```powershell
# 在本仓库所在目录执行（相对路径按当前工作目录解析）
dsh plugin --profile web add file:./dsh-tool-workspace-migrate
```

peer 依赖（`@deepseek-ai/dsh-tools`、`dsh-agent-presets`、`dsh-llm`）随
dsh 本体自带，无需另行安装。两种方式改完都需**重启 `dsh web`** 生效。

### 方式 C（进阶）：免 pnpm 直接 patch

把 `lib/index.js` 复制进 web profile 目录
（POSIX `~/.dsh/profiles/web/lib/workspace-migrate.js`；Windows
`C:\Users\<你>\.dsh\profiles\web\lib\workspace-migrate.js`），
并在该 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: tool-workspace-migrate
      name: './lib/workspace-migrate.js'
```

## 使用示例

```text
先 list_workspace_sessions，传入共享源目录的绝对路径，看有哪些对话；
然后 migrate_workspace：
  migrations = [
    { session_id: "session-aaa", target_path: "D:\\work\\proj-login" },      # Windows 示例，须绝对路径
    { session_id: "session-bbb", target_path: "/home/alice/work/proj-pay" }  # POSIX 示例
  ]
  copy_mode = "full"   # 首次迁移建议 full，先保证不丢东西
  carry_context = true
  archive_source = true
```

想"干净分割、只迁本对话产物"时，把 `copy_mode` 换成 `artifacts` 并用
`extra_paths` 补齐 `node_modules`、`.git`、`.env` 等依赖——**但要明白
`artifacts` 会丢掉"只读依赖 / shell 间接产物"，见下一条限制。**

## QQ 通道自动重绑（@tencent-connect/dsh-qqbot）

被迁移的会话若绑定了 QQ 通道（c2c/群聊），工具在建好续接会话后会自动改写两处映射，让 QQ 端接续迁移后的对话：

- `~/.dsh-qqbot/model-prefs.json`：把该通道 sessionKey 的会话覆盖指向续接会话（入站路由）；
- `~/.dsh-qqbot/session-peers.json`：为续接会话补登对端条目，并**删除同一对端（scope+peerId）的旧条目**——原子转移，一个 QQ 对端始终只保留一条映射（Web 回合立即可镜像到 QQ）。

sessionKey 优先按 `SHA256("qqbot:<appId>:<scope>:<peerId>")` 与源会话 id 做**密码学比对**确认（appId 取自各 profile 的 `im-qqbot` 配置），比对不上则回退反查 prefs 中指向源会话的键。迁移链可叠加：再次迁移同一对话会把键改指到最新的续接会话。注意 **bot 进程启动时缓存这两个文件，改完需重启宿主进程生效**（返回 `qq_channel.needs_restart: true` 即提示此事）。未装 qqbot、源会话无绑定、或解析不出 sessionKey 时均为无害的静默跳过；可用 `rebind_qq_channel: false` 显式关闭。

### 查看与手动改绑：`list_qq_bindings` / `rebind_qq_channel`

- `list_qq_bindings`（无参数）：只读返回 `bindings[]`（`session_key`→`session_id`，入站路由表）、`model_overrides[]`（各通道的模型偏好）、`peers[]`（出站镜像条目，含 `has_last_msg_id`）。
- `rebind_qq_channel`：把某个 QQ 通道手动指到任意**已存在**的会话（目标 id 会先校验存在性）。必填 `session_id`；定位键可显式传 `session_key`，或给 `source_session_id`（当前绑定的会话）作提示，否则按"目标自身的绑定线索 → 唯一已知绑定"自动推断；推断有歧义时返回 `ambiguous-session-key` 并附 `known_bindings` 供重试。返回 `ok`、`session_key`、`previous_session_id`、`peers_seeded`、`needs_restart`。

> ⚠️ 不要手改这两个 JSON 时用 PowerShell `Set-Content -Encoding UTF8`（PS 5.1 会写入 BOM，可能导致 bot 解析异常）；插件工具始终写无 BOM 的 UTF-8，读取侧也做了 BOM 容错。

## 限制与风险

- **文件操作不走 shell 沙箱**：复制用进程内 `node:fs`，可写 dsh 进程能写的任意目录；这是迁移必须的，代价是**该插件是受信代码**，且只作用于显式传入的路径与源会话自身的 cwd。
- **`artifacts`/`artifacts_read` 是"必要但不充分"的快照**：日志只记录 `write/edit/read` 的结构化路径；经 shell 命令间接读写的文件（`python src/main.py`、`git`、`npm run build` 产物）**无法归属到会话**，因此这两个模式可能让迁移后的会话访问不到它原本依赖的内容。要"不丢东西"就用默认的 `full`。
- **每个目标可能重复**：同一文件若被多条会话 `edit` 过，会出现在多份目标里。
- **“带上下文继续”= 新会话**：产物是新 `sessionId`，源会话与被迁文件不被改动。`continuation_error` 非空表示种子会话建立失败（但文件已复制、工作区已登记、源会话已归档——可用取消归档找回）。
- **归档只隐藏、不删**：`archiveSession` 仅追加到 `archivedSessionIds`，源目录与源日志原样保留；若想"迁完后清空源目录里已迁走的文件"，需要另一个显式清理动作，本工具不代做。
- **改绑是文件级操作，运行中的旧进程会回写覆盖**：bot 启动时一次性读入 prefs/peers 缓存，未重启前它每次落盘都用**旧缓存**整体重写，可能冲掉刚补的条目（实测发生过：迁移写好的 peers 新条目被旧进程的回写抹掉）。改绑后应尽快重启宿主进程，重启前避免 QQ 收发。

## 更新历史

### v0.1.7 — 通道改绑改为「原子转移」（未发布）

- 修复：`rebindQQChannel` / `setQQChannelBinding` 换绑时只补登新对端条目、从不删同对端（scope+peerId）旧条目，导致反复迁移/改绑后 `session-peers.json` 累积「同一 peer 挂着 N 个 sessionId」（`list_qq_bindings.peers` 出现多条同 peer）。
- 现在补登新条目前先删同对端旧条目（一个对端始终只保留一条映射），改绑语义从「累加」变为「转移」。
- 测试 `qq-rebind.test.mjs` 的 A3 断言由「source kept」改为「source removed」，21 项全绿。

### v0.1.6 — 文档同步（行为零变更）

- 0.1.5 发布时「更新历史」章节尚未入库，npm 首页缺失 changelog；本版仅让 README 文档随包重新上线。
- 工具行为、schema、依赖与 v0.1.5 完全一致（测试基线同 commit 复跑通过）。

### v0.1.5 — 通道改绑一等工具化

- 新增 `list_qq_bindings`（只读）：一屏看清入站路由表（`session_key`→`session_id`）、各通道模型偏好、出站镜像条目。
- 新增 `rebind_qq_channel`：手动把 QQ 通道指到任意已存在会话（目标 id 先验证存在）。定位键支持显式 `session_key` / `source_session_id` 提示 / 目标自身绑定线索 / 唯一绑定兜底，歧义时返回 `ambiguous-session-key` 并列出候选；可复制的对端条目会自动补登。
- JSON 读取兼容 UTF-8 BOM（规避 PowerShell `Set-Content` 的 BOM 坑），工具写入恒为无 BOM。
- 「限制与风险」补充实测坑位：运行中的 bot 会用旧缓存整体回写两个映射文件，改绑后需尽快重启。

### v0.1.4 — 输出 schema 修复

- `migrate_workspace` 输出中的 `qq_channel` 由裸 `{"type":"object"}` 补全为完整声明（`additionalProperties: false` + 逐属性）。dsh 的 schema 方言要求 object 类型在**注册期**显式声明 `additionalProperties`，裸 object 会导致工具注册失败。
- 该修复以真实 dsh-tools 做注册烟雾测试验证（4 工具注册通过）。

### v0.1.3 — QQ 通道自动重绑（@tencent-connect/dsh-qqbot）

- `migrate_workspace` 新增 `rebind_qq_channel` 参数（默认开）：迁移绑定了 QQ 通道的会话时，自动把通道映射改指到续接会话（写 prefs 入站覆盖 + 补 peers 出站条目），未绑定/未装 qqbot 时无害跳过；结果含 `qq_channel`（`needs_restart` 提示）。
- sessionKey 解析优先 SHA-256 密码学比对（appId 扫描各 profile 的 `im-qqbot` 配置），回退 prefs 值反查；支持迁移链叠加。
- 重绑逻辑独立为 `lib/qq-rebind.js`（纯 Node 依赖），新增 `npm test` 回归测试（纯 fixture，无外部依赖），发布 tarball 不含测试目录。

> 0.1.3 之前为迁移工具本体的初始打磨（`list_workspace_sessions` / `migrate_workspace`、npm 化与兼容范围调整），未逐版记录。

## 开发与发布

```powershell
git commit -am "..."                    # 提交改动
npm version patch                       # bump 版本，自动 commit + 打 tag
git push origin main --tags
npm publish                             # 发布需要 2FA 交互验证
```