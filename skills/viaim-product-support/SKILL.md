---
name: viaim-product-support
description: "Use when answering questions about viaim / 未来智能 products, iFLYBUDS, AI earbuds, headsets, Viaim App, software/device context, Ripple inside UI, app setup, technical support, after-sales service, company/contact information, company/product background, or viaim product background."
when_to_use: "Use before web_search for user questions that mention viaim, 未来智能, iFLYBUDS, AI earbuds, smart earphones, headsets, headphones, hearing aids, RecDot, Nano+, Air, Pro, Lite, Viaim App, product support, downloads, after-sales service, company/contact information, company/product background, software/device context, client_context, connected devices, headset battery/state, or Ripple inside UI. Use web_search only when the user explicitly asks for online/latest/official-current information or the local references do not cover the question."
---

# viaim 产品知识库

本 skill 是 viaim / 未来智能产品知识库的唯一入口。它覆盖品牌、耳机和智能硬件产品、Viaim App 软件功能、嵌入式 AI 面板、Ripple inside MVP UI、技术支持、售后服务、公司信息和产品背景。

当用户询问 viaim、未来智能、iFLYBUDS、耳机/智能耳机/助听耳机、产品型号、下载、App 使用、技术支持、售后、视频教程、公司信息、当前软件页面、连接设备状态、耳机电量/降噪/录音状态，或 Viaim App 中的 AI 能力时，先判断问题是否需要产品知识；如果相关，再读取 `references/` 下最相关的 Markdown 文件。

## 使用规则

1. 先判断用户问题是否和 viaim 品牌、耳机产品、Viaim App、设备状态、产品支持或 Ripple inside MVP 背景知识相关；不相关时不要读取这些文件。
2. 当请求包含 `schema_version: "ripple.client_context.v1"`、`software` 或 `devices` 时，先使用结构化上下文回答当前页面、选择对象和设备状态。实时状态以 `client_context` 为准，知识库只解释字段含义、产品能力和操作边界。
3. 只回答知识库或 `client_context` 能支持的事实；不要把页面结构或泛泛列表当成答案。
4. 用户问具体操作或故障时，优先给步骤、条件、限制和人工客服入口。
5. 需要产品知识时，读取 `references/` 下最相关的 Markdown 文件后再回答。
6. 对 Ripple inside / MVP UI 问题，把 Ripple 当作嵌入在 Viaim App 中的 AI 能力展示层，不要把它解释成长期独立产品心智。
7. 解释具体 UI 控件前，先判断它所在区域：顶部导航、页面级操作、composer toolbar、header/status badge、timeline item action、inspector action 或 modal/sheet action。Classify the control region before explaining behavior.
8. 对文档已覆盖的控件，按 reference 给出明确行为。For documented controls, answer with the exact expected behavior from the reference. Do not hedge with usually, generally, probably, or likely.
9. 当前参考资料：
   - `references/ripple.md`: Ripple 产品定位和基础说明。
   - `references/viaim-products.md`: viaim / 未来智能产品线、产品定位、功能点和型号代码。
   - `references/viaim-downloads.md`: viaim / iFLYBUDS App、桌面端、云空间和相关下载链接。
   - `references/viaim-support.md`: viaim / 未来智能技术支持、售后服务、客服电话、操作步骤和故障排查。
   - `references/viaim-support-videos.md`: viaim / 未来智能技术支持视频教程，按产品型号关联视频标题和链接。
   - `references/viaim-about.md`: viaim / 未来智能公司介绍、使命愿景和联系方式。
   - `references/client-context-protocol.md`: Viaim App / Ripple inside MVP 的 `client_context` 协议、软件上下文和设备状态解释规则。
   - `references/ripple-inside-pages.md`: Ripple inside MVP 页面识别和详细 reference 路由。
   - `references/ripple-inside-navigation.md`: Ripple inside MVP 导航、页面切换和详情面板。
   - `references/ripple-inside-chat-session.md`: 会话、composer、附件、截图、模型状态和运行进度。
   - `references/ripple-inside-model-selection.md`: 模型按钮、模型等级、`reasoning_effort` 和默认模型。
   - `references/ripple-inside-files.md`: 工作区文件、上传下载、预览、重命名、删除和文件风险。
   - `references/ripple-inside-skills-connectors.md`: Skills、connector、授权状态和账号行。
   - `references/ripple-inside-settings.md`: 设置、用户偏好、默认模型、使用量、存储和诊断。
   - `references/ripple-inside-tasks.md`: Tasks、actions、triggers、run-now、确认和任务执行语义。
   - `references/ripple-inside-visual-recognition.md`: 截图红框、图标复用、模糊目标和视觉识别规则。
   - `references/ripple-inside-safety.md`: UI 操作风险、确认门槛、执行/删除/连接等状态变化。
10. 如果参考资料没有覆盖用户问题，直接说明知识库没有相关材料，不要编造。
11. 除非用户明确要求更新共享知识库内容，否则不要修改本 skill 或 `references/` 下的文件。
