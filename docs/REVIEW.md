# MyLLMTring 代码审查报告

> 审查标准：① 模块化封装，主程序只做组装，按功能组织文件层级 ② 代码顶部有简明注释  
> ③ 前后端高度解耦 ④ 根目录 README 有简单启动命令 ⑤ 每个功能文件夹有简短 README
>
> 结论先行：**这个项目"能跑"但"不像一个工程"。** 核心矛盾是——`
> 复现别人的项目占了 90% 的体量，而真正属于你自己的、也是唯一需要长期维护的代码
> （shim + 启动脚本 + 文档），恰好是最薄、最散、最没规范的部分。`  
> 下面逐条对照标准给出具体批评，每条都带可验证的事实。

---

## 一、按标准逐条批评

### 标准 ① 模块化封装 —— ❌ 不合格

**事实**：`shim/server.js` 单文件 319 行，一个文件同时承担 **7 种职责**：

| 职责         | 位置                  | 说明                                                    |
| ---------- | ------------------- | ----------------------------------------------------- |
| HTTP 服务与路由 | `L278` `L315`       | 3 条路由挤在一个回调里                                          |
| SSE 协议构造   | `L74-L157`          | 5 个函数拼 6 个事件                                          |
| Dify 客户端   | `L45`               | HTTP 调用 + 会话记忆                                        |
| 请求体解析      | `L60` `L159` `L175` | `lastUserText` / `lastToolCallName` / `lastEventText` |
| 业务决策       | `L194`              | `handleResponses` 一个函数 80+ 行，串起判断→问模型→合成→回包           |
| 全局状态       | `L29`               | `let conversationId` 模块级可变变量                          |
| 诊断/调试      | `L200-L215`         | 打印 input 尾部 + 覆写磁盘文件                                  |

**具体问题**：

1. **`handleResponses` 80 行巨石**（`L194-276`）。它同时做"判断该不该说话""调模型""拼 SSE""写调试文件"四件事，无法单测。任何一个环节改动都要通读全文。
2. **模块级可变状态**（`L29 conversationId`）——这是无法写单元测试的根本原因。要测 `handleResponses` 就必须先把它变成依赖注入。
3. **零测试**。今晚那个 `arguments` 累加的 bug，如果有 4 个 SSE 结构的用例，5 分钟就能发现；实际花了三轮排查。
4. **没有 `package.json`**（根目录、`shim/` 都没有）。零依赖不代表不需要依赖声明——缺 `scripts`、缺 `engines`、缺 `name/version`，`start-pet.bat` 只能硬编码 `node shim/server.js`。
5. **有死代码**：`messageItem`（`L88`）定义了 87 行文件里从未被引用——上一次改用 function_call 路径后遗留的尸体。

**整改方向**：

```
shim/
  index.js          # 只做组装：建 HTTP 服务、挂路由、listen
  config.js         # PORT / DIFY_URL / MODEL / DIFY_KEY 全部可注入
  routes/
    models.js       # GET /models
    responses.js    # POST /responses，只做「解析 → 调 handler → 写 SSE」
  core/
    decision.js     # 纯函数：该说话还是该闭嘴（可单测）
    input-parser.js # 纯函数：lastToolCallName / lastEventText / lastUserText
  protocol/
    sse.js          # 纯函数：合成六事件，canonical 语义集中一处
    responses.js    # baseResponse / petSayCall 等
  clients/
    dify.js         # 会话记忆作为实例状态，而非模块全局
  diagnostics.js    # 用 DEBUG=1 环境变量开关，默认关闭
```

### 标准 ② 代码顶部简明注释 —— ⚠️ 良莠不济

**做得好的**：`shim/server.js` 顶部 18 行块注释交代了背景、数据流、启动方式；`src/chat.py` 有规范模块 docstring。这一点确实做到了。

**没做到的**：

1. `start-pet.bat` 通篇零注释。这个脚本承担了四步依赖检查和 PowerShell 子命令，**恰恰是最需要说明的文件**，读的人无从得知每一步的失败意味着什么。
2. `docs/` 下的三篇开发日志（`docs/log/day1~3`）没有任何索引或说明，读者不知道它们该按什么顺序读。
3. 注释写"是什么"而非"为什么"。比如 `lastEventText` 上方那段解释了为什么不能看 `function_call_output`——**这是好注释**。但 `functionCallSse` 里 6 个事件的顺序为什么是这个顺序、`sequence_number` 为什么从 0 开始，一个字都没有。而今晚那个 bug 恰恰出在这里。

### 标准 ③ 前后端高度解耦 —— ⚠️ 架构对，工程实现差

**架构上是干净的**：桌宠（Electron 前端）↔ shim（HTTP 后端）之间只有 `POST /responses` + `GET /models` 两个端点，进程、语言、部署位置全独立。这是本项目唯一设计得漂亮的地方。

**但实现上被破坏**：

1. **调试代码焊死在生产路径上**（`L200-L215`）。每一轮对话都会覆写一个 55KB 的 `last-input.json`，并向 stdout 打印 10 行 input 摘要。**没有 `DEBUG` 开关**——排障时它是救命工具，日常跑时它是纯开销，而且完整对话内容（含用户隐私）持续落盘。
2. **两个客户端重复实现同一套逻辑**。`src/chat.py`（`strip_thinking`、`dify_chat`）和 `shim/server.js`（`stripThinking`、`askDify`）是同一套 Dify 客户端的两份拷贝，连注释都近乎重复。逻辑一旦变更（例如 Qwen 换思考模式格式）必须改两处。
3. **`src/chat.py` 定位不明**。它既不是应用层、也不是 shim 层的模块，更像是调试期的临时脚手架，却和正式代码平级放在 `src/`。要么进 `tools/`，要么删掉。
4. **Dify 才是真正的"后端大脑"，但它是一坨黑盒**。人设、会话记忆、提示词全在 Dify 里，项目代码无从得知。这意味着**桌宠的"性格"不可版本控制**——Dify 里改一个字，`git log` 查不到。

### 标准 ④ 根目录 README 有简单启动命令 —— ❌ 不合格

**事实**：README 第 23-24 行全文如下：

```
### 启动流程：1，打开Linux虚拟机，待dify自启动
### 2，点击start-pet.bat，启动桌宠
```

**问题**：

1. **漏了必需前置**：Ollama 完全没提。而 `start-pet.bat` 的第 1 步就是检查 Ollama——照 README 做完还是起不来。
2. **漏了 Dify 的安装**：没写 Dify 从哪来、向量库为什么换 pgvector、那 15 个容器怎么起来的。**Dify 部署本身就是本项目最难的一步，README 把它当黑盒跳过了。**
3. **漏了密钥配置**：`DIFY_KEY` 走环境变量（`server.js:24`），但 README 没提。不设的话 shim 静默用兜底假 key，报 401 让人摸不着头脑。
4. **漏了 provider 切换**：控制台默认是云端 `ds`，不手动切 `qwen3-8b` 桌宠就不理人。README 没提这一步。
5. **README 自己承认了失败**（第 13 行）："所以就导致了这个项目你大概只能看看，但是想要复现有点麻烦"。**这不是谦虚，是文档缺失的自陈。** 你的二面评委看到这句话，等于被告知"这个项目别人跑不起来"。

一份合格的启动文档应该是：

```bash
# 0. 前置
#    - Ollama 桌面版已启动（托盘图标）
#    - VMware Ubuntu VM 已启动（Docker 与 15 个容器自启）
#    - 环境变量 DIFY_KEY=app-xxxx（dify 控制台 → 应用 → API 密钥）
# 1. 一键启动
start-pet.bat
# 2. 首次需要在 http://127.0.0.1:17788 把模型切到 qwen3-8b
#    （脚本已自动切换，此步仅在异常时手动）
```

### 标准 ⑤ 每个功能文件夹有简短 README —— ❌ 最刺眼的一项

**事实对比**（这组数字最能说明问题）：

| 目录                                        | README 数  | 说明             |
| ----------------------------------------- | --------- | -------------- |
| `coopanion/vendor/cortico/src/core/`      | ✅         | 上游文档齐全         |
| `coopanion/vendor/cortico/src/providers/` | ✅         |                |
| `coopanion/packages/*/`                   | ✅ 每个都有    |                |
| **`shim/`**                               | ❌ **0 个** | 319 行协议适配器，零文档 |
| **`src/`**                                | ❌ **0 个** |                |
| **`docs/`**                               | ❌ **0 个** | 3 篇日志裸奔，无索引    |

**讽刺之处**：你复现的**别人的**项目，每个功能目录都有 README；而你**自己写的**代码，一个都没有。

尤其 `shim/` 必须有 README 的理由：它实现的是一套非公开的协议适配，涉及 Cortico 的内部约定（`external_event_frame` 承载用户输入、`arguments` 必须是真空串）。**这些知识今晚全部只存在于你的脑子里和我写的那份 `docs/bubble-fix-handoff.md` 里，而那份文档不在 `shim/` 旁边。** 三个月后你自己回来改，照样得从头考古。

---

## 二、问题清单（按严重度排序）

| #  | 问题                            | 严重度  | 证据                                   |
| -- | ----------------------------- | ---- | ------------------------------------ |
| 1  | shim 无 README，关键协议知识无处可查      | 🔴 高 | `shim/` 0 个 md                       |
| 2  | 无任何测试，今晚的 bug 靠肉眼排查           | 🔴 高 | 全项目 0 测试                             |
| 3  | 根 README 缺 4 个必需步骤，且自陈"复现麻烦"  | 🔴 高 | `README.md:13,23-24`                 |
| 4  | 调试代码焊在生产路径，无开关，持续落盘隐私         | 🟠 中 | `server.js:200-215`                  |
| 5  | shim 319 行 7 职责 + 模块级全局状态     | 🟠 中 | `server.js`                          |
| 6  | Dify 客户端两份重复实现                | 🟠 中 | `chat.py:47,62` vs `server.js:35,45` |
| 7  | 配置硬编码（URL/PORT/MODEL 写死）      | 🟡 低 | `server.js:22-26`                    |
| 8  | 死代码 `messageItem`             | 🟡 低 | `server.js:88`                       |
| 9  | 无 package.json                | 🟡 低 | 根目录 & shim/                          |
| 10 | `src/chat.py` 定位不明，与正式代码平级    | 🟡 低 | `src/`                               |
| 11 | `README-EXTRA/` 目录名不规范，图片哈希命名 | 🟡 低 | 根目录                                  |
| 12 | `.workbuddy/` 记忆目录混在交付仓库      | 🟡 低 | 已 gitignore，但物理在仓库内                  |

---

## 三、客观地说，做对的部分

批评之外，有三点确实是做得对的，不要在整改时拆掉：

1. **`shim/server.js` 顶部的注释质量不错**——交代了背景、数据流、协议差异和踩坑点，函数级注释也解释"为什么"（如 `lastEventText`）。这是全项目文档质量最高的地方，只是位置错了（应该在独立 README 里 + 保留简短文件头）。
2. **`docs/log/day1~3` 的开发日志是好习惯**，记录了每天的进展与截图。缺的只是一个 `docs/README.md` 索引。
3. **架构边界选对了**：桌宠与大脑之间用 HTTP 协议解耦，而不是把逻辑塞进 Electron 主进程。这个决定让整个方案在可控范围内跑通了。
4. **`.gitignore` 写得很规范**，运行产物（`run.log` / `last-input.json` / `__pycache__`）都已正确排除，`git status` 干净。这是仓库卫生里最容易做错的一环，你做对了。

---

## 四、如果只做三件事

按投入产出比排序：

1. **写 `shim/README.md`**（1 小时）  
   把协议契约、六事件序列、`arguments` 必须是真空串、`external_event_frame` 承载用户输入这四条写清楚。  
   ——这是唯一能让"三周后的自己"省下三个晚上的动作。
2. **给根 README 补齐启动前置**（30 分钟）  
   加上 Ollama、`DIFY_KEY`、Dify 部署来源、provider 切换。删掉"复现有点麻烦"那句。  
   ——直接决定你的二面评委能不能跑起来。
3. **给 `handleResponses` 抽 4 个纯函数 + 写 5 个用例**（2 小时）  
   把"该不该说话"的判断抽成纯函数，用今晚遇到的四种 input 尾部形态做断言。  
   ——今晚三轮排查的时间成本，一份测试就能压到十分钟。
