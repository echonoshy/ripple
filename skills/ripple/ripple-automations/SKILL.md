---
name: ripple-automations
version: 1.0.0
description: "说明 Ripple 定时/周期任务的职责边界：Ripple 负责确认、落库和触发，Codex 不自己调度。"
when-to-use: "用户想创建未来任务、定时任务、提醒、每天/每周/每隔一段时间重复执行的 Codex 任务。"
---

# ripple-automations

Use this skill when the user asks about future or recurring tasks and the request has reached normal Codex chat.
Most schedule creation requests should be intercepted by Ripple before normal chat and handled by Ripple's structured
schedule extraction workflow.

## Boundary

- Ripple may use Codex internally as a structured extractor, but normal Codex chat should not invent its own schedule
  protocol.
- Ripple validates, confirms, stores, and triggers schedules.
- Do not run the requested future task immediately unless the user explicitly asks for a one-off run now.
- Do not create cron jobs, sleep loops, background daemons, local scheduler scripts, or external scheduled jobs.
- Do not call Ripple HTTP APIs from Codex to create the schedule.
- Do not output JSON schedule proposals in the final answer. The control-plane protocol is internal to Ripple.

## Required Information

Before proposing a schedule, make sure these fields are clear:

- `title`: short user-facing schedule title.
- `prompt`: the exact future instruction Codex should receive each time the schedule fires.
- `kind`: `once` or `interval`.
- `timezone`: IANA timezone, for example `Asia/Shanghai` or `UTC`.
- `run_at`: ISO 8601 datetime for one-time schedules, or optional first run time for interval schedules.
- `interval_seconds`: required for interval schedules.
- `max_runs`: optional run limit for interval schedules, used when the user asks to run a recurring task a fixed
  number of times.

If normal chat receives a scheduling request, explain that Ripple should handle it through the Automations confirmation
flow. Do not fabricate a JSON proposal.

## Time Handling

- Use the current date/time from the prompt context.
- Convert relative dates such as "tomorrow", "明天", "next Monday", or "每天早上 9 点" into concrete ISO 8601 datetimes.
- Preserve the user's intended timezone when it is known. If the user does not specify a timezone, use the server/user timezone from the prompt context when available; otherwise use `UTC`.

## Output

Normal Codex chat should answer in plain language only. Schedule creation should happen through Ripple's internal
structured extraction workflow and user confirmation, not through assistant-visible JSON.
