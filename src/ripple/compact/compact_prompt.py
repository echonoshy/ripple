"""压缩摘要提示词

定义 LLM 摘要压缩所需的 system prompt 和 user prompt。
参考 Claude Code 的 compact prompt 设计。
"""

COMPACT_SYSTEM_PROMPT = (
    "You are a helpful AI assistant tasked with summarizing coding conversations. "
    "Your goal is to create a concise but comprehensive summary that preserves "
    "all information needed to continue the work effectively."
)

COMPACT_USER_PROMPT_TEMPLATE = """\
Summarize the conversation above into a structured summary. The summary will replace \
the original messages, so it must preserve all important context.

Output your summary in the following format:

<summary>
## User Intent
[What the user originally asked for and their goals]

## Completed Work
[What has been done so far — files created/modified, features implemented, bugs fixed]

## Current Task Status
[Task list status if any tasks were created, otherwise skip]

## Key File Changes
[Important files that were read, created, or modified with brief descriptions]

## Important Context
[Any critical decisions, constraints, error patterns, or domain knowledge discovered]

## Pending Work
[What still needs to be done, if anything]
</summary>

Rules:
- Be concise but do not drop important details
- Include file paths when relevant
- Preserve any error messages or patterns that were discovered
- Do NOT include the conversation messages themselves, only the summary
- Output ONLY the content within <summary> tags
"""


def format_compact_summary(raw_response: str) -> str:
    """从 LLM 响应中提取摘要内容"""
    if "<summary>" in raw_response and "</summary>" in raw_response:
        start = raw_response.index("<summary>") + len("<summary>")
        end = raw_response.index("</summary>")
        return raw_response[start:end].strip()

    return raw_response.strip()
