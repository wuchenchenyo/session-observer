# 多 Agent 协同记录

“协同”页把 **Codex 主控 → 执行器返回 → Codex 独立验收** 串成父子任务树。记录包括派发简报、命令摘要、模型请求值与响应元数据、结果、失败类别、退回重做、验收证据和显式关联的会话。页面每 10 秒刷新，也可手动刷新。

它只展示通过本地记录器登记的工作，不会自动读取其他 Agent 的隐藏推理、拦截所有应用调用，或根据时间、路径猜测父子关系。已有 Codex/Claude/Grok/Antigravity 会话解析仍独立工作；某个会话存在，不代表已经有协同任务记录。

## 记录目录与权限

Node.js CLI 位于 `server/collaboration-cli.js`，无需新增依赖。默认账本：

```text
~/.session-observer/collaboration/collaboration-ledger.jsonl
```

CLI 与服务器必须使用同一个目录。可同时设置 `OBSERVER_COLLABORATION_DIR` 为一个绝对路径，或在 CLI 使用 `--directory /absolute/private-ledger`。未设置时也可通过 `OBSERVER_DATA_DIR` 改变父目录。

读取空目录不会创建文件；首次登记自动创建专用目录（0700）和账本（0600）。已有共享权限目录、最终目录符号链接及不合规账本会被拒绝写入，不会自动 chmod 用户目录。请使用新建的专用目录。不要把账本放在公开仓库中。

## 最小工作流

以下在仓库根目录执行。示例 ID 只使用一次，后续创建应省略 `id` 让记录器生成 UUID，或换一个唯一 ID。

```bash
node server/collaboration-cli.js create --input - <<'JSON'
{"id":"demo-root","title":"验证协同记录","executor":"codex","permission":"read-only","brief":"只处理合成资料，独立检查子任务结果。"}
JSON
node server/collaboration-cli.js event demo-root started --input - <<'JSON'
{"command":"Codex 主控与独立验收"}
JSON
node server/collaboration-cli.js create --input - <<'JSON'
{"id":"demo-child","parentTaskId":"demo-root","title":"合成本地执行器","executor":"grok","permission":"read-only","brief":"返回一条合成结果；本例不调用 Grok 服务。"}
JSON
node server/collaboration-cli.js run demo-child --timeout 30 -- node -e 'process.stdout.write("synthetic result")'
node server/collaboration-cli.js show demo-child
```

最后一步显示 `awaiting_review`，**退出码 0 不代表验收通过，也不证明 Grok 可用**。检查真实结果后，显式附上证据：

```bash
node server/collaboration-cli.js event demo-child reviewed --input - <<'JSON'
{"outcome":"passed","summary":"独立检查合成结果与预期一致。","evidence":[{"label":"实际检查记录","path":"/absolute/acceptance.txt"}]}
JSON
```

证据路径应替换为实际存在的检查记录；记录器只存引用，不替用户验证内容。所有子任务通过或取消后，主任务可依次登记 `returned` 和 `reviewed`。

## 派发与接回

任务字段：`id`（可省略）、`parentTaskId`（根任务省略）、`title`、`executor`、`modelRequested`（可选）、`brief`、`cwd`（绝对路径，可选）、`permission`、`writePaths`。执行器支持 `codex`、`claude`、`grok`、`antigravity`。

- `read-only` 不允许声明写入路径；`patch`、`write` 必须明确声明至少一个文件或目录。补丁输出文件也属于写入。
- `run TASK_ID --timeout 300 --brief-file /absolute/brief.txt -- executable args...`：直接启动已指定程序，不经过 shell，将原始获准简报送到 stdin，记录脱敏简报、命令摘要和返回。需要 prompt 文件参数的执行器仍应在其参数中明确给出文件。命令摘要用于展示，不是可直接重放的 shell 脚本。
- `--result-file /absolute/result.txt` 可改用该文件作为返回摘要；读取失败或超过 64 KiB 则阻塞。每次使用新文件，避免误读旧结果。可选 `--metadata-file` 仅识别本项目 Claude 适配器的已知元数据格式。
- 默认超时 300 秒，可设 1–3600 秒；超时与中断会终止受管进程组。主动脱离该组的程序不在此保证范围内，Windows 仅终止直接子进程。
- 只向子进程继承 PATH/HOME、用户、语言、终端、临时目录和 XDG 路径等基础环境，以及 `OBSERVER_MANAGED_RUN`、`OBSERVER_TASK_ID`、`OBSERVER_PARENT_TASK_ID`；不会转发任意 API Key。既有登录状态、实际工具权限和费用路由须在执行器自己的受控入口核验。

使用 Grok 或 Antigravity CLI 时，将已验证、已获准的入口放到 `--` 后。没有通过这个入口发起的 GUI 操作，须在真实派发和返回时由主控显式登记 `started` / `returned`；不能宣称已自动采集全部调用。不要为增加日志而重新运行已经完成的业务任务。

### Claude 无持久会话复核入口

```bash
python3 examples/claude-review.py \
  --brief /absolute/approved-brief.txt \
  --out /absolute/new-review.txt \
  --observer-parent EXISTING_PARENT_TASK_ID \
  --timeout 300
```

该适配器要求已安装 Node.js、Python 3、Claude CLI，并在正常接口完成 Claude 订阅登录。它禁用工具、Chrome 和会话持久化，拒绝显式 API/provider 环境覆盖；不设置付费回退。它自动创建子任务并记录返回，仍等待 Codex 独立验收。省略父 ID 时创建根任务，也可由 `OBSERVER_PARENT_TASK_ID` 指定父 ID。

模型来自响应 `modelUsage`，不采用模型自述。无持久会话时保留调用时间线和结果，不生成不可用的 Claude Session 链接。输出文本和 `.meta.json` 保留在用户指定目录，它们本身不经过账本的脱敏程序。

## 状态与事件

| 事件 | 前置状态 | 结果与主要字段 |
| --- | --- | --- |
| `started` | queued / rework | running；brief、command、timeoutSeconds，可选 recorderPid；尝试次数 +1 |
| `returned` | running | awaiting_review；summary，可选 exitCode、modelObserved、artifacts |
| `reviewed` | awaiting_review | outcome 为 passed / partial；summary；passed 必须有 evidence |
| `rework` | awaiting_review / partial / blocked | rework；必须有 reason，可选 category |
| `blocked` | 非 passed / cancelled | blocked；reason、可选 summary、category |
| `cancelled` | 非 passed / cancelled | cancelled；建议填写 reason；父任务有执行中子任务时拒绝 |
| `session_linked` | 已存在任务 | provider、sessionId；只绑定明确核实的会话，不推测 |

`artifacts` / `evidence` 是 `{ "label": "说明", "path": "/absolute/file" }` 或 `{ "label": "说明", "url": "https://..." }` 数组。页面只把 http/https URL 变成链接，文件路径显示为文字。

```bash
node server/collaboration-cli.js event demo-child rework --input - <<'JSON'
{"reason":"补充边界情况；原结果未满足验收条件。"}
JSON
```

上例仅适用于尚未通过的任务。再次 `run` 才会重新执行，没有自动重试。父任务不能在未完成子任务仍存在时通过，也不能在已通过/取消的祖先下面添加或启动任务。

关联会话使用会话库返回的实际 ID：Codex/Claude 原始 ID，Grok 为 `grok:ID`，Antigravity 为 `antigravity:desktop:ID` 或 `antigravity:cli:ID`。账本只校验格式，不证明源文件存在。

## 健康快照与并发

`health --input file.json` 接受 `executor`、`status`（available / blocked / unknown）、`summary`、可选 `category` 和 `checkedAt`。只在实际核验之后写 `available`，并在摘要说明能力范围和证据。常见失败类别为 auth / quota / permission / tool / network / timeout / runtime。通用 runner 的成功或失败只产生 **unknown** 快照和输出分类，不能替代真实可用性检查。页面显示最近检查时间，不自动探测登录或消耗额度。

同一账本最多允许 2 个外部任务同时 running，Codex 不计入外部数；所有执行中的任务都受写入声明重叠检查。路径会解析现有符号链接，覆盖父子目录冲突；macOS/Windows 保守地按大小写不敏感比较。事务使用短时文件锁，竞争者失败返回 busy；检查当前状态后再试，不能盲目重放调用。

**这些是协同声明和冲突检查，不是操作系统沙箱，也不授予审批或外部数据共享权限。** 任意本地程序仍可能写声明外路径、读取 HOME 中可访问的文件或创建脱离管理的进程；隔离和审批必须由原执行环境落实。绕过记录器的任务、其他账本和手工篡改不受这些约束。页面没有运行、审批或修改任务的 HTTP 接口。

## 崩溃、容量与隐私边界

- JSONL 追加有锁和 fsync；正常写入失败会尝试回滚本次追加。断电、SIGKILL 或存储损坏仍可能留下半条记录，读取会报错并停止，不静默忽略。
- 锁目录 `.collaboration-ledger.lock/owner.json` 记录 PID 和创建时间。没有自动夺锁或租约过期：若长期 busy，先暂停写入并确认该 PID 已退出且没有其他活跃写入，再备份账本、只清理此专用锁。不能仅凭时间认定锁已失效。
- `started` 记录 recorderPid 和超时；记录器异常退出后任务可能仍显示 running。先检查记录器、子进程及工作文件，确认实际执行已停止，再显式登记带原因的 blocked / cancelled 来释放声明。不能仅因 PID 不存在就自动重跑。
- 达到 16 MiB 账本、1000 个任务或每任务 200 个事件时拒绝继续追加。单条记录上限 32 KiB；简报和结果摘要各最多 8192 字符；标准输出/错误合计最多捕获 64 KiB。长内容截断，不能当作完整上下文归档。
- 不自动轮转、迁移或删除历史。容量到限且无活跃任务后，关闭写入、备份并切换新专用目录，CLI 与服务器同步配置。损坏文件应保留副本，人工核对最后完整记录后恢复，不能跳过错误继续执行。
- 入账前清理常见密钥、Bearer、私钥、密码和带凭据 URL；这是尽力脱敏，不能保证识别所有秘密或业务隐私。不要把密钥、余额明细、生产配置等未经授权的资料放入简报、参数或结果。输入文件、执行器自己的日志与输出文件不受此清理保证。
- 账本是本地操作记录，不是防篡改审计证据；`reviewed` 表示主控写下的结论，记录器无法验证是谁完成检查、证据内容是否正确。保持服务仅监听本机，勿未经授权开放网络访问。

## 验证

运行 `npm run check`。测试使用合成任务和假执行器，覆盖返回/验收/退回、并发和路径冲突、失败分类、超时清理、脱敏、私有权限、无持久 Claude 会话、页面筛选/关联/刷新及详情请求失败重试。它们不调用实际供应商、不证明登录或额度当前有效。

2026-09-11 本地验收：110 项前端测试、157 项核心测试、严格 ESLint 与生产构建通过。Chrome 桌面及 390px 宽度检查任务筛选、父任务保留、派发详情展开、关联 Grok 会话跳转和当前任务自动刷新；390px 时无横向溢出。独立 HTTP 检查确认读取 200、缺失任务 404、POST/DELETE 405。全部使用合成数据，没有读取或发布真实账户记录。
