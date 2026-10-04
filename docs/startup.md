# 启动流程：`start-pet.bat` 详解

> 这份文档解决什么问题：**双击 `start-pet.bat` 之后卡住了/报错了，该怎么办**。
> 按顺序体检整条链路：密钥 → Ollama → Dify(VM) → shim → 桌宠控制台 → 桌宠。

脚本会开一个窗口并**保持打开**——关掉窗口（或 Ctrl+C）就等于关掉桌宠。

---

## 启动前的前置条件

脚本**不会**帮你做这三件事，必须先备好：

| 前置 | 说明 |
| --- | --- |
| **Ollama 已在运行** | 它**没有注册成系统服务**，必须手动起：命令行 `ollama serve`，或点系统托盘的 Ollama 图标。验证：`curl http://127.0.0.1:11434/api/tags` 能返回模型列表 |
| **VMware Ubuntu VM 已启动** | Dify 跑在 VM（`192.168.126.128`）里。VM 一开，Docker 和全部 15 个容器会靠 restart policy `always` 自己起来，**不需要进 VM 里手动操作** |
| **`DIFY_KEY` 已配置** | Dify 应用的 API 密钥。**推荐写进 `shim/.env`**（该文件已被 git 忽略）：<br>`DIFY_KEY=app-xxxxxxxx`<br>key 在 Dify 控制台 → 你的应用 → API 访问 → API 密钥。<br>也可用系统环境变量 `DIFY_KEY`（**环境变量优先于 `.env`**），但 `setx` 必须重开终端才生效，所以双击 bat 启动的场景请用 `.env`。<br>⚠️ 旧 key 因曾被硬编码提交到 GitHub 而**已作废**，不要复用。 |

验证 VM 里 Dify 是否就绪：浏览器能打开 <http://192.168.126.128> 就说明容器起来了。

---

## 六个步骤

脚本按顺序做 6 件事，每步都有明确的检查目标。

### `[1/6]` 检查 Dify API key

**查什么**：`shim/.env` 里存在 `DIFY_KEY=app-...`，且**不含占位符标记 `KEY-HERE`**；
若系统环境变量 `DIFY_KEY` 已设置，则直接放行。

**失败怎么办**：脚本会停并打印 `[FAIL] No usable Dify API key`，
告诉你 key 该放哪、去哪拿。**不会**带着假 key 去跑然后静默 401。

> 这一步是后加的。原来脚本不管 key 有没有都照跑，
> 结果是「桌宠默默不响应、日志里只有 401」——比直接报错难查得多。

### `[2/6]` 检查 Ollama（`127.0.0.1:11434`）

**查什么**：HTTP GET `/api/tags` 能不能通（超时 3 秒）。

**失败怎么办**：脚本直接停并提示。手动起 Ollama（`ollama serve` 或托盘图标）后重新双击。
**这一步不能跳过**——Ollama 挂着时 Dify 能起来但推理会失败。

### `[3/6]` 检查 Dify（VM，`192.168.126.128`）

**查什么**：能不能 HTTP 访问到（超时 8 秒，比第 1 步宽松，因为 VM 容器可能还在起）。

**失败怎么办**：先确认 VM 开着；刚开机要**等 1-2 分钟**让 15 个容器自启完再重试。
还是不行就进 VM 看容器：

```bat
ssh -i C:\Users\28687\.ssh\ubuntu_vm lesm1128@192.168.126.128
sudo docker ps          # 应有 15 个容器
```

### `[4/6]` 检查 shim（端口 `8787`）

**查什么**：本机`8787` 端口有没有在监听。

- **没在监听** → 脚本自动启动：`node shim\index.js`，输出重定向到 `shim/run.log`
- **已经在监听** → 脚本**直接复用旧进程**，不会重启

> ⚠️ **这一步的「复用旧进程」是个坑**：改过 `shim/` 下的代码后，
> 必须先手动关掉旧 shim 进程再运行脚本，否则测的还是旧代码。
> 今天排查时就在这里浪费过时间——脚本显示一切正常，但跑的是改动前的进程。

想看 shim 到底在干什么，直接看日志：

```
shim/run.log        # stdout，含每轮请求、决策结果、Dify 答案
shim/run.err        # stderr
shim/last-input.json# 完整 input 快照（需设 DEBUG=1 才会生成，见 shim/README.md）
```

### `[5/6]` 等待桌宠控制台（端口 `17788`）

**查什么**：轮询 `17788` 是否开始监听，最多等约 30 秒（15 次 × 2 秒）。

**为什么需要**：桌宠启动后，控制台里激活的模型 provider 决定它走哪条链路。
如果激活的是**云端 provider `ds`**，桌宠就**不会走本地 shim**，也就用不上本地模型。

**做什么**：一旦控制台起来，脚本会POST `http://127.0.0.1:17788/api/providers/qwen3-8b/activate`
把 provider 切到本地 shim 对应的 `qwen3-8b`。

**失败怎么办**：30秒内控制台没起来，脚本会跳过自动切换并提示
`console not up yet - skipping auto-select`。此时**手动**打开
<http://127.0.0.1:17788> 把模型切到 `qwen3-8b`，否则桌宠不会调本地工具。

> 控制台地址：<http://127.0.0.1:17788>

### `[6/6]` 启动桌宠

**做什么**：`cd D:\aiu\MyLLMTring\coopanion` 然后 `pnpm dev`。

同时打印控制台地址，并提示**关掉窗口即停止桌宠**。

需要能正常对话就算成功——桌宠会冒气泡。

---

## 环境要求

| 项 | 要求 |
| --- | --- |
| 仓库路径 | **必须全ASCII 路径**。仓库当前在 `D:\aiu\MyLLMTring`；放到中文路径下会让 Node 的 `cpSync` 崩在 `0xC0000409`（栈溢出类错误） |
| Node | >= 18（shim 零第三方依赖，直接 `node` 跑） |
| 包管理器 | `pnpm`。⚠️ `coopanion/package.json` 的 `packageManager` 字段必须与**本机实际版本一致**（当前 `pnpm@12.3.4`）。pnpm 10+ 会自管理版本，声明与本机不一致时它去解析 `@pnpm/exe@<旧版本>` 会失败，导致**所有 pnpm 命令都跑不起来**（连 `pnpm --version` 都报错） |
| Python | 仅 `src/chat.py` 调试时需要，纯标准库 |

---

## 没气泡怎么查

按这个顺序，从上往下排除：

1. **key 配了吗** —— 脚本第 1 步过了吗？`shim/.env` 里的占位符换掉了吗（搜 `KEY-HERE`）
2. **Ollama 在跑吗** —— `curl http://127.0.0.1:11434/api/tags`
3. **Dify 在跑吗** —— 浏览器能开 `http://192.168.126.128` 吗
4. **shim 在跑吗、跑的是新代码吗** —— `shim/run.log` 里这一轮有请求记录吗？改过代码的话，旧进程关了吗
5. **provider 选对了吗** —— <http://127.0.0.1:17788> 里当前激活的是 `qwen3-8b` 还是云端 `ds`
6. **有 401 吗** —— `run.log` 里搜 `Dify HTTP 401`，是 key 没配/配错
7. **SSE 结构被上游判 aborted 吗** —— 设`DEBUG=1` 重跑看 `run.log`

第4、5、7 步的详细判法见 [`../shim/README.md`](../shim/README.md) 的「铁律」和「故障排查」；
第 1~3 层根因的完整复盘见 [`./bubble-fix-handoff.md`](./bubble-fix-handoff.md)。

**想跳过桌宠快速验证链路** —— 直接用联调CLI：

```bat
python src/chat.py --provider ollama    # 只测模型
python src/chat.py --provider dify      # 测智能体
```

见 [`../src/README.md`](../src/README.md)。

---

## 相关文档

- [`../README.md`](../README.md) —— 项目总览与完整架构
- [`../shim/README.md`](../shim/README.md) —— 协议适配层细节
- [`./bubble-fix-handoff.md`](./bubble-fix-handoff.md) —— 今天这次「气泡不出来」排障的完整过程
