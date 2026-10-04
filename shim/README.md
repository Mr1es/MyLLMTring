# shim —— 协议适配层

> 这份文档解决什么问题：**为什么桌宠不能直接连 Dify**、shim 到底在两种协议之间翻译了什么，
> 以及「桌宠不出气泡」时该从哪一层开始查。改 shim 之前请先读「铁律」和「Cortico input 结构」两节。

shim 是本项目**唯一需要长期自己维护的代码**（其余是复现的开源桌宠）。
零第三方依赖，只用 Node 内置 `node:http` 与全局 `fetch`，Node >= 18 可直接运行。

---

## 一、为什么需要它：两边协议不对话

| | 桌宠（Coopanion / Cortico 框架） | 大脑（Dify 智能体） |
| --- | --- | --- |
| 协议 | OpenAI **Responses** | Dify **Chat Messages** |
| 端点 | `POST <baseUrl>/responses` | `POST /v1/chat-messages` |
| 传输 | **严格的 SSE 事件序列** | 单次 JSON（`response_mode: blocking`） |
| 说话方式 | 只能通过**工具调用**（`pet_say` / `pet_ask`） | 返回一段**纯文本** `answer` |

两处硬性不兼容：

1. **端点与响应格式不同** —— 桌宠只会发 `/responses`，Dify 只会收 `/v1/chat-messages`。
2. **桌宠看不见纯文本** —— 这是最关键的一点。桌宠世界只把 `pet_say` / `pet_ask`
   工具的调用结果渲染成头顶气泡，模型直接回文本**用户永远看不到**。
   所以 shim 必须把 Dify 的文本答案**合成为一个 `pet_say` 的 function_call**，
   由桌宠 Core 派发给宠物世界去显示。

数据流：

```
桌宠 ──POST /responses──► shim(127.0.0.1:8787) ──POST /v1/chat-messages──► Dify ──► Ollama(Qwen3:8b)
     ◄──SSE 六事件序列────                      ◄──JSON answer──────────
```

shim 对上游 Dify 是**无状态 HTTP 客户端**（自己维护 `conversation_id` 做多轮记忆），
对下游桌宠是**严格按协议吐 SSE 的服务端**。

---

## 二、两个端点的契约

### `GET /models` —— 模型清单

Cortico 的 `ModelCatalog.list()` 会先调它确认可用模型。返回**静态**清单，不碰 Dify：

```json
{ "object": "list", "data": [{ "id": "qwen3:8b", "object": "model", "created": 0, "owned_by": "dify-shim" }] }
```

控制台里填的模型名必须与这里的 `id` 一致，否则桌宠认不出这个provider。

### `POST /responses` —— 对话主链路

请求来自 Cortico，shim 只关心三件事：`body.model`、`body.stream`、`body.input`。
响应分三种情况：

| 情况 | 触发条件 | HTTP | 事件 |
| --- | --- | --- | --- |
| 说话 | 该说话且 Dify 成功 | 200 | 六事件序列（见下） |
| 闭嘴 | 宠物刚说完话 / 没有可回应内容 | 200 | `created` + `completed`（`output` 为空） |
| 失败 | Dify 不可达或返回非 2xx | **502** | `created` + `failed`（带 `error.message`） |

设计取舍：**先决策再调 Dify**。该闭嘴时直接回空结束回合，
既省掉一次模型调用（每次要好几秒），也避免桌宠自言自语。

---

## 三、铁律：`output_item.added` 的 `arguments` 必须是真空串 `''`

**这是今天修掉的核心bug，也是「桌宠永远不出气泡」的真正原因。**

看 `protocol/responses.js` 里的 `petSayItemAdded`：

```js
// ✅ 正确：真空串
arguments: '', status: 'in_progress'

// ❌ 错误：曾经写成这样（复用了 petSayCall(..., '', ...)）
arguments: '{"script":""}'
```

**为什么 `{"script":""}` 是错的**：`arguments` 是**增量累加型**字段。
上游 Cortico 框架会把 `delta` 累加到 `output_item.added` 给出的起始值上，
再与 `output_item.done` 里的干净值做比对。于是：

```
起始 '{"script":""}'  +  delta '{"script":"你好"}'
  =  '{"script":""}{"script":"你好"}'      ← 累加结果
  ≠  '{"script":"你好"}'                    ← done 里的干净值
```

校验器直接抛 `Final function arguments disagree with deltas`，
**整条流被判为 aborted，工具永远不执行** —— 表现就是「桌宠没有气泡」，
而且服务端日志里看不到任何错误，很容易查错方向。

> **通用教训：增量累加型字段的起始值必须是「该类型的空值」，
> 不能是「空内容的序列化结果」。**
> 空串是空串，`{"a":""}` 是一个已经序列化的对象，两者语义完全不同。

改这块之前请先读 `protocol/sse.js` 文件头：**事件类型、`sequence_number`
必须连续、字段名，都是协议的一部分，不要随手调整。**

---

## 四、Cortico input 结构（实测，最容易踩坑的地方）

这是理解 shim 的前提。桌宠每一轮发来的 `input` **不是增量，而是全量上下文**——
历史里的 `function_call` / `function_call_output` 会一直堆在数组里。
实测尾部结构如下：

```
message(user)        [system] 2 条新事件。
reasoning
function_call        external_event_frame
function_call_output [2 new events] [互动] … [打字] les:你是谁？
function_call        pet_say
function_call_output 已开始显示,这段约 3 秒。
```

三条来之不易的结论（对应 `core/input-parser.js` 文件头）：

### 1. 用户打的字**不在 user message 里**

user message 只有一句干巴巴的「`[system] 2 条新事件。`」。
用户真正说的话躺在 **`external_event_frame` 这个 function_call 的
`function_call_output`** 里，形如：

```
[2 new events] [互动] … [打字] les:你是谁？
```

所以 `lastEventText()` 从后往前找第一个 `function_call_output`，
剥掉 `[N new event(s)] ` 前缀，只留后面真正的事件描述。
**只拿 user message 去问模型，模型根本不知道用户说了什么。**

### 2. 不能只看「最后一项是不是 `function_call_output`」

每个 `function_call` 后面都跟着它的回执，所以这个条件**恒真**，毫无信息量。
判断必须落在**位置**上：看最后一个 `function_call` 的 `name`。

### 3. 因为是全量上下文，「只要含有 X 就……」的判断从第二轮起就永久失效

历史项永远堆在数组里。任何基于「是否出现过某个工具」的判断都会被历史污染，
只能用「最后一项是什么」或「最后一个 function_call 的 name」。

完整落盘样本见 `shim/last-input.json`（运行时产物，`.gitignore` 已排除，
本地跑一次 `DEBUG=1` 才会生成）。

---

## 五、该说话还是该闭嘴

逻辑集中在 `core/decision.js`（纯函数，无 IO，可单测）：

```
最后一个 function_call 是 pet_say / pet_ask  →  闭嘴（宠物刚说完，别自言自语）
拿不到任何可回应的事件正文                 →  闭嘴（省一次模型调用）
否则                                       →  说话
```

**反直觉但正确的一点**：紧跟在 `external_event_frame` 后面的那个
`function_call_output`，恰恰是**该说话**的那一轮 —— 因为宠物刚问完「有没有新事件」，
拿到的是用户的新输入，此时不接话才是错的。
只有当最后一个工具调用**本身就是** `pet_say` / `pet_ask` 时，才说明它刚讲完。

---

## 六、配置

全部集中在 [`config.js`](./config.js)，其他模块一律从这里取，
不让 `core/` `protocol/` 里的纯函数偷偷依赖环境变量（保持可单测）。

| 项 | 默认值 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| 监听地址 | `127.0.0.1` | — | 只绑回环，不对外网暴露 |
| 端口 | `8787` | `SHIM_PORT` | |
| Dify 地址 | `http://192.168.126.128/v1/chat-messages` | `DIFY_URL` | 换 VM / 切环境用 |
| Dify API Key | `app-YOUR-KEY-HERE`（兜底假key） | **`DIFY_KEY`** | 见下方警告 |
| Dify user | `coopanion-pet` | `DIFY_USER` | Dify 用它做会话隔离 |
| 对外模型名 | `qwen3:8b` | `MODEL` | 必须与 `/models` 和控制台填的一致 |

**取值优先级：系统环境变量 `DIFY_KEY` > [`shim/.env`](./.env) > 兜底假 key。**

> ⚠️ **key 必须配**，否则会用兜底假 key，Dify 返回 **401**，
> 而 shim 只是把错误包成 `failed` 事件 —— **静默失败，桌宠默默不响应**。
>
> **推荐写法：填 [`shim/.env`](./.env)**（该文件已被 `.gitignore` 忽略，不会被提交；
> 模板见 [`.env.example`](./.env.example)）：
>
> ```ini
> DIFY_KEY=app-你从Dify控制台拿到的真key
> ```
>
> `config.js` 用零依赖方式读它（只用 `node:fs`，无 dotenv 依赖）。
> 之所以不用 `setx` 系统环境变量：它必须**重开终端**才生效，
> 对「双击 `start-pet.bat` 启动桌宠」这个场景不友好。
>
> key 从 Dify 控制台 → 你的应用 → **API 访问** → API 密钥 获取。
> 真 key 永远不提交进仓库。
>
> ⚠️ 旧 key曾被硬编码提交到 GitHub，**已作废**，不要复用。

---

## 七、`DEBUG=1` 调试用法

shim 是长驻进程，默认只输出关键三行（收到请求 / 决策结果 / Dify 答案），
因为全量打印会撑爆 `run.log`、也淹掉真正的报错。

设`DEBUG=1` 打开**重诊断**（`diagnostics.js`）：

```bat
set DEBUG=1
node shim/index.js
```

开启后多两件事：

1. 打印 `input` **尾部 10 项**的结构摘要 —— 看清「用户说的话」和「工具回执」谁排在最后；
2. 把**完整 input 落盘**到 `shim/last-input.json`（`.gitignore` 已排除的运行时产物）。

排查「这一轮到底该不该说话」时这是唯一手段：
先看尾部摘要判断结构对不对，再去 `last-input.json` 里核对完整字段。

不设 `DEBUG=1` 时不会生成/更新 `last-input.json`（文件是`.gitignore` 的运行时产物）。

---

## 八、代码结构

```
shim/
├── index.js              入口（组装层）：读配置 → 建 HTTP 服务 → 挂路由 → listen
├── server.js             兼容入口（已废弃），仅为兼容旧脚本/旧链接
├── config.js             全部配置，支持环境变量覆盖
├── diagnostics.js        关键三行日志 + DEBUG=1 重诊断
├── routes/
│   ├── models.js         GET  /models
│   └── responses.js      POST /responses —— 只做编排，不含协议知识
├── core/                 纯函数，无IO，可单测
│   ├── decision.js       该说话还是该闭嘴
│   └── input-parser.js   读 input 的三条协议知识
├── protocol/             OpenAI Responses 协议的数据形状
│   ├── responses.js      baseResponse / petSayCall / petSayItemAdded
│   └── sse.js            六事件序列 + SSE 序列化
└── clients/
    └── dify.js           唯一对外说话的地方；conversation_id 挂在实例上
```

依赖方向单向向内：`index → routes → {core, protocol, clients} → config`。
`core/` 与 `protocol/` 不碰 `http`/`res`，改协议可以脱离 HTTP 单测。

---

## 九、故障排查

| 现象 | 先查什么 | 怎么处理 |
| --- | --- | --- |
| **桌宠完全没反应** | VM 开着吗 | 启动 VMware Ubuntu VM，等 1-2 分钟让 Dify 自启；浏览器能开 `http://192.168.126.128`吗 |
| | Ollama 起了吗 | **Ollama 没注册成系统服务，必须手动启动**：跑 `ollama serve` 或点托盘图标。验证：`curl http://127.0.0.1:11434/api/tags` |
| | shim 在跑吗 | `shim/run.log`（`start-pet.bat` 会自动重定向）。端口：`netstat -ano \| findstr 8787` |
| | 控制台 provider 选错了吗 | 桌宠激活的可能是**云端 provider `ds`**，那样不会走本地 shim。在 `http://127.0.0.1:17788` 切到 **`qwen3-8b`**（`start-pet.bat` 会自动 POST 激活） |
| **日志里有 401** | `DIFY_KEY` 没配或配错 | 检查 [`shim/.env`](./.env)（或环境变量 `DIFY_KEY`）里是否填了真 key、占位符有没有换掉。`start-pet.bat` 第 1 步会提前拦下未配置的情况 |
| **有请求、有Dify 答案，就是没气泡** | 大概率是 SSE 结构被上游判 aborted | 打开 `DEBUG=1` 复现，看 `run.log`。确认 `output_item.added` 的 `arguments` 是真空串 `''`，且六事件顺序/`sequence_number` 连续（见「铁律」） |
| | 桌宠是不是在跑旧 shim 进程 | 改完 `shim/` 的代码必须**重启 shim**。`start-pet.bat` 见到 8787 已监听会直接复用旧进程 —— 改了代码就手动关掉旧进程再启动 |
| | Dify 答了但内容是空的 | 看 `run.log` 里 `answer 0 chars`。可能是 Dify 侧应用没配好，或人设prompt 出了问题 |
| 桌宠说的话带`<think>` 内心独白 | Qwen3 思考模式泄漏 | `clients/dify.js` 的 `stripThinking()` 是代码层兜底；根治要改 Dify 里的人设输出规则（见 [`persona.md`](../persona.md)） |
| 报 `Final function arguments disagree with deltas` | `arguments` 起始值不是真空串 | 见「铁律」一节 |

改完 shim 记得**重启进程**，否则测的还是旧代码——这本身就是一个查了两小时的坑。

---

## 相关文档

- [`../docs/startup.md`](../docs/startup.md) —— `start-pet.bat` 五个启动步骤详解
- [`../docs/bubble-fix-handoff.md`](../docs/bubble-fix-handoff.md) —— 今天这次排障的完整过程记录
- [`../persona.md`](../persona.md) —— 桌宠人格（鲸鲸）的唯一事实来源，配置在 Dify 里
- [`../README.md`](../README.md) —— 项目总览与架构图
