"""Simplify Bundled Skill

代码审查和清理技能，参考 claude-code 的实现。
"""

from ripple.skills.registry import register_bundled_skill

SIMPLIFY_PROMPT = """# Simplify: Code Review and Cleanup

Review all changed files for reuse, quality, and efficiency. Fix any issues found.

## Phase 1: Identify Changes

Run `git diff` (or `git diff HEAD` if there are staged changes) to see what changed. If there are no git changes, review the most recently modified files that the user mentioned or that you edited earlier in this conversation.

## Phase 2: Review the Changes

Review the changes for the following issues:

### Code Reuse
1. **Search for existing utilities and helpers** that could replace newly written code
2. **Flag any new function that duplicates existing functionality**
3. **Flag any inline logic that could use an existing utility**

### Code Quality
1. **Redundant state**: state that duplicates existing state
2. **Parameter sprawl**: adding new parameters instead of generalizing
3. **Copy-paste with slight variation**: near-duplicate code blocks
4. **Leaky abstractions**: exposing internal details
5. **Unnecessary comments**: comments explaining WHAT instead of WHY

### Efficiency
1. **Unnecessary work**: redundant computations, repeated file reads
2. **Missed concurrency**: independent operations run sequentially
3. **Hot-path bloat**: new blocking work in critical paths
4. **Memory**: unbounded data structures, missing cleanup
5. **Overly broad operations**: reading entire files when only a portion is needed

## Phase 3: Fix Issues

Fix each issue directly. If a finding is not worth addressing, note it and move on.

When done, briefly summarize what was fixed (or confirm the code was already clean).
"""


def register_simplify_skill():
    """注册 simplify 技能"""
    register_bundled_skill(
        name="simplify",
        description="Review changed code for reuse, quality, and efficiency, then fix any issues found",
        content=SIMPLIFY_PROMPT,
        allowed_tools=["__all__"],  # 允许使用所有工具
        when_to_use="After making code changes, to review and improve code quality",
    )
