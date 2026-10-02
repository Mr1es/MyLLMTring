# 🐋 MyLLMTring（此不为最终版本，但经历了技术路线的更改）

### 张嘉润 · 人工智能协会创智部二面实战项目：deepseek桌面宠物

**技术路线（初版）**：ollama + qwen3-8b + 桌宠api接入本地模型（因为没看清楚题目，觉得第一大题的模型部署以及智能体搭建要一起搞，后来发现扣子只针对云端模型部署，不是我想要的，遂更改）
**技术路线（第二版）**：ollama（跑在windows） + qwen3-8b（本地部署） + dify&docker（跑在Linux虚拟机，但是webui在windows，用于打造人设并提供api）调用ollama + 本地大肥鱼桌宠软件api接入

可能你会觉得dify会有点多余了，毕竟人设可以直接本地写一个就行了，但是我打算将错就错，通过这种绕圈子的方式把两个小题一起做了。


**主要功能** ：
可以与桌面宠物进行语言互动（类似于chatbot）


*为了美观，在开源项目*[Pal-AI-Lab/Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 借了动画素材
