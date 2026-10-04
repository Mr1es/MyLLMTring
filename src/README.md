# src —— 全链路联调 CLI

> 这份文档解决什么问题：**不启动桌宠也能验证「模型 → Dify → 桌宠话术」这条链路通不通**，
> 以及改 Dify 客户端时该改哪里、不该改哪里。

[`chat.py`](./chat.py) 是一个单文件交互式命令行工具，纯 Python 标准库实现
（`urllib` + `json`，无第三方依赖），用来把「问一句」这件事单独拎出来调。

**它是调试工具，不是产品链路的一部分。**正式运行时桌宠走的是
`shim → Dify`，`src/chat.py` 不参与。

---

## 一、两种模式

同一个脚本，用 `--provider` 切换两条不同的链路：

```bat
python src/chat.py# 默认，dify 模式
python src/chat.py --provider dify      应用 → Dify → Ollama(Qwen3:8b)
python src/chat.py --provider ollama     应用 → Ollama(Qwen3:8b)（直连，绕开 Dify）
```

| | `--provider dify`（默认） | `--provider ollama` |
| --- | --- | --- |
| 端点 | `http://192.168.126.128/v1/chat-messages` | `http://localhost:11434/api/chat` |
| 需要 VM 开着 | **需要** | 不需要 |
| 需要 `DIFY_KEY` | **需要** | 不需要 |
| 多轮上下文 | 有（自己传 `conversation_id`） | 无（每轮独立） |
| 用来验证什么 | 人设 / prompt / Dify编排是否正常 | 模型本身是否正常、能否加载 |

退出：输入 `exit` 或 `quit`（或 Ctrl+C）。

### 排查思路：先切到 ollama 模式

**模型出问题还是 Dify 出问题，用这个模式快速二分**：

- `--provider ollama` 就不正常 → 问题在**模型层**（Ollama 没起、模型没拉、显存不够）。
  先确认 Ollama 在跑：`curl http://127.0.0.1:11434/api/tags`
- `--provider ollama` 正常、`--provider dify` 不正常 → 问题在**智能体层**
  （Dify 没起、API Key 错、应用编排、人设 prompt）。

这样能把问题锁定在一层，不用在桌宠里盲猜。

---

## 二、配置

与 `shim/config.js` 是同一套环境变量，但**各写了一份**（见下节）：

| 项 | 默认值 | 环境变量 |
| --- | --- | --- |
| Ollama 端点 | `http://localhost:11434/api/chat` | 硬编码 |
| 模型 | `qwen3:8b` | 硬编码 |
| Dify 端点 | `http://192.168.126.128/v1/chat-messages` | 硬编码 |
| Dify API Key | `app-YOUR-KEY-HERE`（兜底假 key） | **`DIFY_KEY`** |
| Dify user | `cli-debug` | 硬编码 |

>⚠️ 同样地：**`DIFY_KEY` 不设会用兜底假 key，然后静默 401。**
> ```bat
> set DIFY_KEY=app-xxxxxxxx
> ```

> ⚠️ Python 版注意：Windows CMD 里 `set VAR=value` 后如果同一条命令行又跑了别的命令，
> 变量可能带上尾部空格导致 key 失效。保险做法是**单独一行设置，换行再执行**。

---

## 三、它和 shim 的 Dify 客户端是重复实现

`src/chat.py` 的 `dify_chat()` 和 [`shim/clients/dify.js`](../shim/clients/dify.js)
的 `ask()` **在做同一件事**：POST `/v1/chat-messages`、带 Bearer key、
维持 `conversation_id`、剥掉 `<think>` 段。区别只有语言（Python / JS）和调用场合。

这是有意识的取舍，不是疏忽：**调试工具必须能脱离整个系统独立跑**，
所以它不能依赖 Node、不能依赖 shim 进程在跑。代价就是两份配置、两份逻辑。

### 为什么不建议两边都改

改动前先分清**改的是哪一边**：

| 要改的东西 | 改哪里 |
| --- | --- |
| 人设、prompt、语气、口癖 | **都不用改代码** —— 改 Dify 控制台里应用的「人设与回复逻辑」（人设文本见 [`persona.md`](../persona.md)） |
| 端点地址、API Key、user | 两个脚本各改一次（都是环境变量优先，优先用环境变量覆盖） |
| 请求体字段 / 响应字段变了 | **改 `shim/clients/dify.js`** —— 只有它对接的是真实链路 |
| 只是想验证一下通不通 | 改 `chat.py` 完全可以，反正它不进生产 |

**判断原则：`chat.py` 是探针，`shim/clients/dify.js` 是产品。**
只改探针不会影响桌宠运行，只改产品不会让你快速调试。
真正要动产品逻辑时，以 `shim/clients/dify.js` 为准。

注意 `stripThinking()` 两边也各有一份。它是Qwen3 思考模式泄漏的**兜底**，
根治办法是人设层禁止输出思考过程 —— 见 [`persona.md`](../persona.md) 的「输出规则」。

---

## 四、常见故障

脚本本身会捕获 `HTTPError` 并直接给出排查提示，常见两类：

**`--provider dify` 报 401** —— `DIFY_KEY` 没设或设错。见上文警告。

**`--provider dify` 报连接失败** —— 依次确认：

1. VM 开着吗（`--provider ollama` 能通说明网络和 Ollama 没问题）
2. Dify 容器起来了吗：`ssh -i C:\Users\28687\.ssh\ubuntu_vm lesm1128@192.168.126.128` 然后 `sudo docker ps`（应有 15 个容器，restart policy 均为 `always`）
3. 浏览器能开 `http://192.168.126.128` 吗

**`--provider ollama` 报连接失败** —— Ollama 没起。它**没有注册成系统服务**，
需手动启动：`ollama serve` 或点系统托盘图标。

**回复里带 `<think>...</think>`** —— 见上文 `stripThinking()` 的说明。

**回答要等好几秒** —— 正常。走 Dify +本地 8B 模型，每轮几秒。

---

## 相关文档

- [`../shim/README.md`](../shim/README.md) —— 正式链路的适配层（产品侧）
- [`../persona.md`](../persona.md) —— 人格文本，改语气应该改这里而不是改代码
- [`../README.md`](../README.md) —— 项目总览
