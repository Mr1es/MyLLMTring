"""MyLLMTring CLI —— 通过 Ollama 本地 API 与大模型对话。

仅使用 Python 标准库，无需安装第三方依赖。

用法：
    python src/chat.py

退出：输入 exit 或 quit
"""

import json
import urllib.request

OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL = "qwen3:8b"


def chat(message: str) -> str:
    """向本地 Ollama 发送一条消息，返回模型的回复文本。"""
    payload = json.dumps(
        {
            "model": MODEL,
            "messages": [{"role": "user", "content": message}],
            "stream": False,
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data["message"]["content"]


def main() -> None:
    print(f"MyLLMTring CLI (model: {MODEL}) —— 输入 exit 退出")
    while True:
        try:
            user_input = input("\n你: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见！")
            break

        if user_input.lower() in {"exit", "quit"}:
            print("再见！")
            break
        if not user_input:
            continue

        try:
            reply = chat(user_input)
        except Exception as exc:
            print(f"[错误] 调用 Ollama 失败：{exc}")
            print("请确认 Ollama 已安装并运行（可先执行 ollama run qwen3:8b 测试）。")
            continue

        print(f"AI: {reply}")


if __name__ == "__main__":
    main()
