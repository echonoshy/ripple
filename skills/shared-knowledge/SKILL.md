---
name: shared-knowledge
version: 1.0.0
description: "Use when answering questions about viaim, Ripple, company/product/project background, product positioning, internal terminology, shared company knowledge, or app/project facts that may be covered by shared Markdown references."
---

# Shared Knowledge

本 skill 提供 viaim、Ripple、公司产品、项目背景和内部术语等共享知识入口。

当用户询问公司、产品、项目、App、术语、FAQ、内部材料或项目背景时，先判断问题是否需要共享知识；如果相关，再读取 `references/` 下的 Markdown 文件。

## 使用规则

1. 先判断用户问题是否和共享知识相关；不相关时不要读取这些文件。
2. 需要共享知识时，读取 `references/` 下最相关的 Markdown 文件后再回答。
3. 当前参考资料：
   - `references/ripple.md`: Ripple 产品定位、架构边界和基础说明。
4. 如果参考资料没有覆盖用户问题，直接说明知识库没有相关材料，不要编造。
5. 除非用户明确要求更新共享知识库内容，否则不要修改本 skill 或 `references/` 下的文件。
