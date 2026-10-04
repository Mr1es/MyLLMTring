"""MyLLMTring CLI —— 应用 ↔ 智能体 ↔ 模型 全链路联调工具。

用法：
    python src/chat.py                       # 默认：Dify 模式（应用 → Dify → Ollama）
    python src/chat.py --provider ollama      # 直连本地模型（单独调试模型层用）

退出：输入 exit 或 quit
"""

import argparse
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

# ---------- 模式一：直连本地 Ollama ----------
OLLAMA_URL = "http://localhost:11434/api/chat"
OLLAMA_MODEL = "qwen3:8b"

# ---------- 模式二：经 Dify 智能体 ----------
DIFY_URL = "http://192.168.126.128/v1/chat-messages"
DIFY_USER = "cli-debug"


def _load_dotenv() -> None:
    """读取 shim/.env，让 CLI 和桌宠用同一份 key。

    与 shim/config.js 的规则保持一致：只认 KEY=VALUE，# 开头是注释，
    已存在的系统环境变量优先、不被文件覆盖。真 key 不进仓库（.env 已被 git 忽略）。
    """
    env_file = Path(__file__).resolve().parent.parent / "shim" / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        key = key.strip()
        value = raw.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


_load_dotenv()

# 从环境变量读，勿把真 key 提交进仓库。shim/.env 优先，系统环境变量覆盖之。
DIFY_KEY = os.environ.get("DIFY_KEY", "app-YOUR-KEY-HERE")


def ollama_chat(message: str) -> str:
    """直连本地 Ollama，返回模型回复。"""
    payload = json.dumps(
        {
            "model": OLLAMA_MODEL,
            "messages": [{"role": "user", "content": message}],
            "stream": False,
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data["message"]["content"]


def strip_thinking(text: str) -> str:
    """过滤 Qwen3 思考型模型的内心独白泄漏。

    Qwen3 默认开启思考模式，可能把 <think>...</think> 过程混进回复。
    人设层已要求"不输出思考"，这里是代码层兜底。
    """
    if "<think>" in text:
        parts = text.split("</think>")
        if len(parts) > 1:
            text = parts[-1]          # 有闭合标签：取标签之后的正式回复
        else:
            text = re.sub(r"<think>.*", "", text, flags=re.DOTALL)  # 无闭合：视为中断的思考
    return text.strip()


def dify_chat(message: str, conversation_id: str | None = None):
    """调用 Dify 应用（Dify 内部调度本地 Ollama 模型）。

    返回 (回复文本, 会话ID)。会话ID 用于多轮对话的上下文延续。
    """
    payload = {
        "inputs": {},
        "query": message,
        "response_mode": "blocking",
        "user": DIFY_USER,
    }
    if conversation_id:
        payload["conversation_id"] = conversation_id

    request = urllib.request.Request(
        DIFY_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {DIFY_KEY}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        data = json.loads(response.read().decode("utf-8"))
    return strip_thinking(data.get("answer", "")), data.get("conversation_id")


def main() -> None:
    parser = argparse.ArgumentParser(description="MyLLMTring 全链路联调工具")
    parser.add_argument(
        "--provider",
        choices=["dify", "ollama"],
        default="dify",
        help="dify=经智能体层（默认）；ollama=直连本地模型",
    )
    args = parser.parse_args()

    if args.provider == "dify":
        print("MyLLMTring CLI [provider=dify] —— 应用 → Dify → Ollama(Qwen3:8b)")
    else:
        print("MyLLMTring CLI [provider=ollama] —— 直连本地模型（调试用）")
    print("输入 exit 退出\n")

    conversation_id = None
    while True:
        try:
            user_input = input("你: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见！")
            break

        if user_input.lower() in {"exit", "quit"}:
            print("再见！")
            break
        if not user_input:
            continue

        try:
            if args.provider == "dify":
                reply, conversation_id = dify_chat(user_input, conversation_id)
            else:
                reply = ollama_chat(user_input)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            print(f"[错误] HTTP {exc.code} {exc.reason}: {body}")
            if exc.code == 401 and args.provider == "dify":
                print("排查：这是 key 问题，不是 VM 问题。检查 shim/.env（或环境变量 DIFY_KEY）里"
                      "是否填了真 key、占位符有没有换掉（搜 KEY-HERE）。")
            elif args.provider == "dify":
                print("排查：① VM 开着吗 ② Dify 容器起来了吗（VM 里 sudo docker ps）"
                      " ③ 浏览器能开 http://192.168.126.128 吗")
            else:
                print("排查：Windows 上 Ollama 起来了吗（托盘图标 / ollama list）")
            continue
        except Exception as exc:
            print(f"[错误] 调用失败：{exc}")
            if args.provider == "dify":
                print("排查：① VM 开着吗 ② Dify 容器起来了吗（VM 里 sudo docker ps）"
                      " ③ 浏览器能开 http://192.168.126.128 吗")
            else:
                print("排查：Windows 上 Ollama 起来了吗（托盘图标 / ollama list）")
            continue

        print(f"AI: {reply}")


if __name__ == "__main__":
    main()
