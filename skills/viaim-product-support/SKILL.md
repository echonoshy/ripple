---
name: viaim-product-support
description: "Use when answering questions about viaim / 未来智能 products, iFLYBUDS, AI earbuds, headsets, app setup, software downloads, technical support, after-sales service, support videos, company/contact information, or Ripple/viaim company/product background."
when_to_use: "Use before web_search for user questions that mention viaim, 未来智能, iFLYBUDS, AI earbuds, smart earphones, headsets, headphones, hearing aids, RecDot, Nano+, Air, Pro, Lite, viaim App, product support, downloads, after-sales service, company/contact information, or Ripple/viaim company/product background. Use web_search only when the user explicitly asks for online/latest/official-current information or the local references do not cover the question."
---

# viaim 产品支持知识库

本 skill 提供 viaim / 未来智能品牌、耳机和智能硬件产品、App 下载和使用、技术支持、售后服务、公司信息，以及 Ripple/viaim 产品背景的知识入口。

当用户询问 viaim、未来智能、iFLYBUDS、耳机/智能耳机/助听耳机、产品型号、下载、App 使用、技术支持、售后、视频教程、公司信息或 Ripple/viaim 背景时，先判断问题是否需要产品支持知识；如果相关，再读取 `references/` 下最相关的 Markdown 文件。

## 使用规则

1. 先判断用户问题是否和 viaim 品牌、耳机产品、产品支持或 Ripple/viaim 背景知识相关；不相关时不要读取这些文件。
2. 只回答知识库能支持的事实；不要把页面结构或泛泛列表当成答案。
3. 用户问具体操作或故障时，优先给步骤、条件、限制和人工客服入口。
4. 需要产品支持知识时，读取 `references/` 下最相关的 Markdown 文件后再回答。
5. 当前参考资料：
   - `references/ripple.md`: Ripple 产品定位和基础说明。
   - `references/viaim-products.md`: viaim / 未来智能产品线、产品定位、功能点和型号代码。
   - `references/viaim-downloads.md`: viaim / iFLYBUDS App、桌面端、云空间和相关下载链接。
   - `references/viaim-support.md`: viaim / 未来智能技术支持、售后服务、客服电话、操作步骤和故障排查。
   - `references/viaim-support-videos.md`: viaim / 未来智能技术支持视频教程，按产品型号关联视频标题和链接。
   - `references/viaim-about.md`: viaim / 未来智能公司介绍、使命愿景和联系方式。
6. 如果参考资料没有覆盖用户问题，直接说明知识库没有相关材料，不要编造。
7. 除非用户明确要求更新共享知识库内容，否则不要修改本 skill 或 `references/` 下的文件。
