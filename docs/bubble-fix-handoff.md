# 事故复盘：桌宠不出气泡

> **这份文档解决什么问题**：把「桌宠没有气泡」这次排障的完整过程写下来——
> 三层根因分别是什么、哪些方向是走错的路、以及那些「服务端日志完全正常、
> 却就是不出气泡」的协议约束到底从哪来。
>
> 只想起步 → 读 [`startup.md`](./startup.md)。
> 想改协议代码 → 读 [`../shim/README.md`](../shim/README.md)。

---

## 一、现象

- 桌宠窗口正常显示，能看见它在监听弹幕/输入
- 但**点击/说话之后没有任何气泡弹出**
- **shim 端无任何报错**，日志干净，HTTP 200
- Cortico 侧工具状态显示 `NOT_EXECUTED_STREAM_ABORTED`
- 诊断包（控制台导出 JSON）里能看到请求确实到达了 shim

「服务端无报错 + 上游说流被中止」这个组合，是本次定位最难的地方。

---

## 二、根因分三层

三个问题**互相独立、必须全部修掉**才出气泡。修掉任何一个，气泡依然不出来，
这也是当时反复拉锯的原因。

### 第1 层：跑的是旧代码进程（假象层）

改了代码没生效——旧进程还占着 8787 端口在监听。

```bash
# Windows 上查谁占着端口
netstat -ano | findstr :8787
# 按 PID 强杀
taskkill //PID <pid> //F
```

**教训**：改 shim 代码后必须确认进程重启过。
现在 `start-pet.bat` 会在启动前检查 8787 是否已被监听，
若在监听则复用该进程（而不是盲目再起一个），避免这一类问题复发。

### 第 2 层：控制台里选中的不是本地 provider（配置层）

`qwen3-8b` 这个 provider 存在，但**没被选中**——桌宠实际在用云端 `ds`。
于是 shim 根本没被调用，气泡自然不会有。

修复是启动时自动激活：

```bash
POST http://127.0.0.1:17788/api/providers/qwen3-8b/activate
```

这条已经内置进 `start-pet.bat` 的第 5 步。

### 第 3 层：SSE `arguments` 累加导致流被判 aborted（协议层·真凶）

这是**真正的核心 bug**，也是最隐蔽的一个。

**背景**：Cortico 桌宠只通过 `function_call` 显示内容，
也就是必须发一个 `pet_say` 工具调用，气泡才会出现。
而 OpenAI Responses 协议里，工具参数是**分片流式累加**的：

```
output_item.added       → arguments: ''            ← 起手必须是空
response.function_call_arguments.delta  → '{"script":'
response.function_call_arguments.delta  → '"你好"}'
response.function_call_arguments.done   → arguments: '{"script":"你好"}'  ← 收尾全量
```

**校验器要求**：把中间所有 delta 顺序拼接起来，必须**严格等于** done 里的全量值。
起始值若不是该类型的空值，就对不上。

**Bug 的具体形态**：原代码为了让 `arguments` 是合法 JSON，写的是

```js
petSayCall(itemId, callId, '', 'in_progress')
// 内部做JSON.stringify({ script: '' }) → 实际发出 '{"script":""}'
```

于是实际序列变成：

```
added:      '{"script":""}'      ← 起手就带了内容
deltas:     '{"script":' + '"你好"}'
拼接结果:   '{"script":""}{"script":"你好"}'   ← 多了一段
done:       '{"script":"你好"}'                 ← 对不上 ✗
```

**后果**：校验失败 → 上游判定流异常中断 → 整个流标记为
`NOT_EXECUTED_STREAM_ABORTED` → `pet_say` 永不执行 → 没有气泡，
且shim 自己完全不知道发生了什么（它只是老实发了自己以为合法的内容）。

**修复**：把「起手」和「发参数」拆成两个函数，起手必须是**真空串**：

```js
// protocol/responses.js
// output_item.added 必须是真空串 —— 这是协议铁律，改动前先读 shim/README.md
function petSayItemAdded(id, callId) {
  return {
    id,
    type: 'function_call',
    call_id: callId,
    name: 'pet_say',
    arguments: '',        // 必须是 ''，不能是 '{"script":""}'
    status: 'in_progress',
  };
}
```

同类型的 `content` / `text` 字段同理：**起始值必须是该类型的空值**。

---

## 三、走错的方向（记录下来避免重走）

排查过程中有两次判断失误，都源于对 Cortico input 结构想当然：

| 错误假设 | 为什么错 |
| --- | --- |
| 「input 里有 `function_call_output` 就说明是工具结果回合」 | input 是全量上下文快照，里面堆着历次所有工具结果，这个条件恒成立 |
| 「最后一项是 `function_call_output` 就是工具回合」 | 顺序不对，实际最后一项常常是别的东西 |

**最终的正确理解**：

1. **用户输入不在 user message 里**。user message 固定是
   `[system] N 条新事件。` 这样的提示，真正的内容藏在
   **最后一个 `external_event_frame` 的 `function_call_output`** 里，形如
   `[1 new event] [打字] les:你好`。
2. **判断「该说话还是该闭嘴」看最后一个 `function_call 的 name`**：
   是 `pet_say` / `pet_ask` 就说明上一轮已经说过了，此时应回空结束回合，
   防止无限自问自答。

对应的纯函数在 `shim/core/input-parser.js`，无IO、可单测。

---

## 四、后来补上的两个坑

### 坑1：Dify key 硬编码进 GitHub（安全问题）

早期版本把应用 API Key 直接写在代码里并提交到了 GitHub，**该key 已作废**。

**现在的做法**：

- 真key 放 `shim/.env`（已被 `.gitignore` 忽略，不会被提交）
- `shim/.env.example` 是模板，告诉你 key 从哪拿
- `shim/config.js` 用零依赖的方式读它；**系统环境变量 `DIFY_KEY` 优先**
- 占位符固定写成 `app-KEY-HERE-PASTE-YOUR-NEW-KEY`，
  `start-pet.bat` 靠 `KEY-HERE` 这个标记识别「还没填」，直接拦下并提示，
  避免「静默用假 key → Dify 返回 401 → 桌宠默默不响应」

> 若key 曾在公开仓库暴露过，除了换新 key，git历史里也仍能翻出旧值。
> 彻底清除需要 `git filter-repo` 之类工具改写历史，
> 并注意**旧 key 必须视为已泄露**——删除历史不等于让它重新有效。

### 坑2：pnpm / corepack 版本自管理冲突（启动阻断）

`coopanion/package.json` 里声明 `"packageManager": "pnpm@11.5.0"`，
而本机装的是 12.3.4。pnpm 10+ 会**自管理版本**，
它去解析 `@pnpm/exe@11.5.0` 时失败，导致任何 pnpm 命令都跑不起来。

试过并**无效**的方案：`corepack prepare`、`COREPACK_ENABLE_STRICT=0`、
`--package-manager-strict`、`PNPM_PACKAGE_MANAGER_STRICT`、配置代理。

**有效解**：把声明改成与本机一致的版本。

```json
"packageManager": "pnpm@12.3.4"
```

`lockfileVersion: 9.0` 与该版本兼容，无需重新 install。
验证：`pnpm --version` 输出 `12.3.4`。

---

## 五、重构后的 shim 结构

排障结束后按工程规范做了模块化拆分。
读代码请从入口 `index.js` 往下走，它是纯组装层：

```
shim/
├─ index.js          入口/组装层：读配置 → 建服务 → 挂路由 → listen（无协议逻辑）
├─ server.js         兼容入口，仅require('./index')
├─ config.js         配置集中 + 零依赖 .env 读取
├─ diagnostics.js    关键日志；DEBUG=1 时打印 input 尾部并落盘 last-input.json
├─ routes/
│  ├─ models.js      GET /models
│  └─ responses.js   POST /responses 编排
├─ protocol/
│  ├─ responses.js   baseResponse / petSayCall / petSayItemAdded / finalResponse
│  └─ sse.js         SSE 六事件序列写出
├─ core/
│  ├─ decision.js    decide()：该说话还是闭嘴
│  └─ input-parser.js  lastUserText / lastToolCallName / lastEventText（纯函数）
└─ clients/
   └─ dify.js        Dify 客户端，闭包持有 conversation_id（无模块级全局状态）
```

**重构后踩到的回归**：`emptySse` / `failedSse` 一度把 completed 对象展开写进
`response.created`，导致 `completed_at` 泄漏成时间戳。
已改用 `baseResponse(id, model)`（其中 `completed_at: null`）统一构造。

---

## 六、如果再遇到「没气泡」

按这个顺序查，别跳步：

1. **端口 8787 在监听吗？** 监听的是不是**最新代码**？（第 1 层）
2. **控制台 provider 选中的是 `qwen3-8b` 吗？**（第 2 层）
3. **shim 的 `.env` 里key 填了吗？** 占位符换掉了吗？（坑 1）
4. **开`DEBUG=1` 重跑，看落盘的 `last-input.json`**：
   - 能看到 `external_event_frame` 的 output 里有用户输入吗？
   - 最后一个 `function_call` 的 name 是什么？
5. **逐条核对 SSE 事件**：`sequence_number` 严格递增、
   `arguments` 起手是真空串、delta 拼接 == done 全量、终态 status 匹配。
   校验器在 `coopanion/vendor/cortico/src/protocol/open-responses/stream.ts`，
   40 多个 `check()`，报哪个 check 就能定位哪个字段。

最快的现场取证：控制台导出诊断包 JSON，
里面有完整的请求 input、原始 SSE 帧和工具执行状态。
