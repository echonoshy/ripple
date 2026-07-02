use std::path::Path as FsPath;

use serde_json::Value;

use crate::skills::{render_skill_manifest_with_options, SkillManifestOptions};
use crate::state::AppState;

#[derive(Debug, Clone)]
pub(crate) struct RequiredSkillContext {
    pub id: String,
    pub name: String,
    pub path: String,
    pub content_hash: String,
    pub content: String,
}

pub(crate) fn build_codex_chat_base_instructions() -> String {
    "You are Codex, running as Ripple's trusted execution plane.\n\
Ripple is the control plane: it owns user identity, sandbox isolation, connector state, permissions, and API/session lifecycle. Do the real work inside the current user's workspace.\n\n\
## Execution Environment Guardrails\n\
- Do not implement model-provider, OpenAI-compatible, Responses API, or chat-completions adapters inside Ripple. Model-provider compatibility is owned by the Codex app-server configuration; Ripple only preserves its public /v1 client response shapes.\n\
- Connector authorization, token capture, account disconnect, and QR login are Ripple control-plane flows. Do not invent ad-hoc auth tool calls.\n\
- Required Skills are explicit client or user selections for the current turn. If present, treat their SKILL.md content as mandatory workflow instructions before considering Available Skills. If a required skill clearly does not match the user's request or provided screen context, say that instead of forcing an unsupported answer.\n\
- Use Available Skills and Connector Status from the per-turn Ripple context to decide whether a skill or connector is needed. For product, company, support, or shared-knowledge questions, read the matching Available Skill before web_search. Only use web_search first when the user explicitly asks for online, latest, or official-current information, or when no relevant skill is listed. Do not infer connector use from keywords alone.\n\
- Do not assume an uploaded screenshot is Ripple UI just because Ripple UI skills are available. Treat it as Ripple UI only when Screen Context says `app: ripple`, when the user explicitly selected a Ripple UI skill, or when the screenshot itself gives strong Ripple-specific evidence; otherwise state the uncertainty.\n\
- Do not collect connector credentials inside Codex. If Google Workspace, Notion, Feishu, or Bilibili is required and the connector status is not_connected, your final answer must contain only this internal control-plane request, with the connector set to one of google_workspace, notion, feishu, or bilibili:\n\
  <ripple_connector_auth_request>{\"connector\":\"google_workspace\",\"force_reauth\":false,\"reason\":\"needs Gmail access\"}</ripple_connector_auth_request>\n\
- For Bilibili tasks, follow the `bilibili` CLI workflow documented by the Bilibili skills.\n\
- For risky connector writes, ask a clear confirmation question and stop. Continue only after the user's next message explicitly approves the specific action.\n\n\
- Ripple uses Tasks as the durable follow-up model. Tasks capture user goals, obligations, deliverables, or multi-step work items that may outlive the current chat. Task actions may have triggers for future or recurring execution; time-based scheduling is just one task-trigger driver. Do not create cron jobs, sleep loops, background daemons, local scheduler scripts, or external scheduled jobs. Do not call Ripple HTTP APIs from Codex to create tasks or triggers; Ripple validates, stores, confirms, and triggers these control-plane records.\n\
- When the user states a durable goal, deliverable, obligation, or multi-step work item that should be tracked beyond the immediate answer, call `codex_app.task_update` with `target=\"task\"` only after the durable objective and at least one concrete next action are clear. Use `mode=\"propose\"` when the task is inferred but clear enough to review; use `mode=\"create\"` only when the user clearly asks to track/create the task. The task captures the durable objective; task actions capture concrete next steps.\n\
- If the task goal, next action, timing, scope, or delivery target is unclear, ask one concise clarification question and do not call `codex_app.task_update` yet. For future or recurring tasks, the trigger time or repeat interval must be clear. For tasks that gather, search, summarize, monitor, or send/update an external service, clarify the source/scope, output format, delivery target, and empty-result/failure behavior before creating the task.\n\
- If `codex_app.task_update` returns `ok=false` with `code=\"task_needs_clarification\"`, ask the returned `clarification_question` to the user and do not claim that a task was created.\n\
- Tasks inferred from prior session context, memories, or recent work must use `mode=\"propose\"`; do not use `mode=\"create\"` unless the user explicitly asks to track or schedule that task.\n\
- For multi-step tasks, create one task with multiple actions instead of putting all phases into one action prompt. Use `sequence_index` only for display/default execution order; it must not be treated as a blocking dependency because unrelated steps may run in parallel. When the user expresses a true dependency such as \"A 做完再做 B\", \"use step 1's result for step 2\", or \"run A five times, then run B twice\", set `depends_on_action_ids` on the dependent action so it unlocks only after the required action completes. Use per-action `max_runs` for phase-specific repeat counts. Ripple's task trigger driver will choose the current ready action on each run.\n\
- When working on a tracked task, call `codex_app.task_update` to report progress: `start_action` when beginning a task action, `complete_action` with a concise `result_summary` when done, `wait_user` when user input is needed, `block_action` when blocked, and `complete_task` when the full task is done.\n\
- Use your own semantic judgement; do not rely on keyword matching. Clear user instructions such as reminders, waiting items, check-ins, and future next steps should become TaskActions on a Task when they need tracking.\n\n\
- User skills live under /workspace/skills. When creating or updating a skill, do not create or edit skill files from a vague request. First gather the skill name, usage scenario, trigger conditions, steps, inputs, output format, dependencies/connectors, risky actions, confirmation requirements, and a test example. Ask one consolidated clarification when details are missing; after the user answers once, proceed with the best available specification instead of asking repeatedly. For skill updates, read the existing skill and adjacent resources first, and modify only that skill directory.\n\n\
- Do not generate images unless the current user explicitly asks to create, generate, draw, or render an image. Reading PDFs, documents, or image inputs must not use image generation.\n\n\
- Ripple user-facing workspace paths use `/workspace/...`, but shell commands run with the workspace or selected context folder as the current working directory. Do not use absolute `/workspace/...` paths in shell commands; that directory may not exist in the shell namespace. When a user asks you to create or edit `/workspace/foo`, translate it to a path relative to the current shell cwd, such as `foo` from the workspace root or `../foo` from `/workspace/subdir`. In final answers and workspace references, still use the user-facing `/workspace/...` path.\n\n\
- Always write temporary analysis, render, OCR, conversion, and inspection artifacts to $TMPDIR or /workspace/.tmp. Do not write derived inspection files into /workspace root unless the user explicitly asks for those files as deliverables; keep final or user-requested outputs under the selected context folder or another appropriate workspace path.\n\n\
- For temporary Python dependencies, use `python --with <package> -- ...` so Ripple can reuse shared read-only package environments. Do not install temporary Python packages with pip install --target or workspace-local tool directories.\n\
- For temporary Node dependencies, keep installs out of /workspace: use `npm install --prefix \"$RIPPLE_NODE_PREFIX\" <package>` and import from `$RIPPLE_NODE_MODULES` when a one-off package is unavoidable. Do not create node_modules under /workspace or /workspace/.tmp.\n"
        .to_string()
}

pub(crate) fn build_codex_chat_turn_context(
    state: &AppState,
    user_id: &str,
    session_id: &str,
    workspace_root: &FsPath,
    context_folder_path: Option<&str>,
    folder_context_evidence: Option<&str>,
    recent_display_context: Option<&str>,
    recent_task_triggers_context: Option<&str>,
    skill_options: &SkillManifestOptions,
    required_skills: &[RequiredSkillContext],
    screen_context: Option<&Value>,
    attachment_items: &[Value],
    system_prompt: Option<&str>,
) -> String {
    let attachment_lines = attachment_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("attachment"))
        .map(|item| {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("attachment");
            let path = item
                .get("workspace_path")
                .and_then(Value::as_str)
                .unwrap_or("");
            let mime_type = item
                .get("mime_type")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream");
            format!("- {name}: {path} ({mime_type})")
        })
        .collect::<Vec<_>>();
    let attachment_section = if attachment_lines.is_empty() {
        "(none)".to_string()
    } else {
        attachment_lines.join("\n")
    };
    let context_folder = context_folder_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("/workspace");
    let context_section = if context_folder == "/workspace" {
        "- Context folder: /workspace (full workspace)\n- Use the full workspace as the default reading and search scope.\n- If the user does not specify an output path, choose the workspace path that best fits the task."
            .to_string()
    } else {
        format!(
            "- Context folder: {context_folder}\n- Treat this folder as the default reading and search scope for this session.\n- Prefer files under this folder when answering questions or inspecting local context.\n- If the task clearly belongs to this folder and the user does not specify an output path, write new files under this folder.\n- If the user specifies a path, follow the user's path exactly when it is valid.\n- Use web_search as a supplement when the user explicitly asks for online/latest information or when local folder evidence is insufficient. When using web_search, distinguish local evidence from web-sourced additions."
        )
    };
    let folder_context_evidence_section = match folder_context_evidence {
        Some(section) if !section.trim().is_empty() => section.trim().to_string(),
        _ if context_folder_path.is_some() => "No automatic folder context evidence was collected. Search or read files under the context folder before using web_search unless the user explicitly asked for online/latest information.".to_string(),
        _ => "(none)".to_string(),
    };
    let recent_display_context_section = recent_display_context
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("(none)");
    let recent_task_triggers_context_section = recent_task_triggers_context
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("(none)");
    let required_skill_section = render_required_skills(required_skills);
    let screen_context_section = render_screen_context(screen_context);
    format!(
        "## Ripple Session\n\
- user_id: {user_id}\n\
- session_id: {session_id}\n\
- workspace: current working directory\n\n\
## Context Folder\n\
{}\n\n\
## Folder Context Evidence\n\
{}\n\n\
## Connector Status\n\
{}\n\n\
## Required Skills\n\
{}\n\n\
## Screen Context\n\
{}\n\n\
## Available Skills\n\
{}\n\n\
## System Instructions\n\
{}\n\n\
## Conversation State\n\
- The Codex persistent thread is the primary execution context and conversation history.\n\
- Ripple includes bounded recent display context below so control-plane-only turns and recovery paths keep local continuity.\n\n\
## Recent Ripple Display Context\n\
{}\n\n\
## Recent Task Triggers\n\
{}\n\n\
## Attachments\n\
{}\n",
        context_section,
        folder_context_evidence_section,
        connector_manifest(skill_options),
        required_skill_section,
        screen_context_section,
        render_skill_manifest_with_options(&state.config, Some(workspace_root), skill_options),
        system_prompt.unwrap_or("(none)"),
        recent_display_context_section,
        recent_task_triggers_context_section,
        attachment_section
    )
}

fn render_required_skills(required_skills: &[RequiredSkillContext]) -> String {
    if required_skills.is_empty() {
        return "(none)".to_string();
    }
    let mut rendered = vec![
        "The client explicitly selected these skills for this turn. Follow each SKILL.md before answering. Resolve any relative resource paths against the directory containing that SKILL.md, then read only the directly relevant referenced files such as `references/*.md` before acting.".to_string(),
    ];
    for skill in required_skills {
        rendered.push(format!(
            "### {}\n- name: {}\n- path: {}\n- content_hash: {}\n\n~~~markdown\n{}\n~~~",
            skill.id,
            skill.name,
            skill.path,
            skill.content_hash,
            skill.content.trim()
        ));
    }
    rendered.join("\n\n")
}

fn render_screen_context(screen_context: Option<&Value>) -> String {
    let Some(screen_context) = screen_context else {
        return "(none)\n- Do not assume uploaded screenshots are Ripple UI without explicit user selection or strong visual evidence.".to_string();
    };
    let json = serde_json::to_string_pretty(screen_context).unwrap_or_else(|_| "{}".to_string());
    format!(
        "Client-provided UI grounding. Prefer this structured context over visual guessing.\n- Do not assume uploaded screenshots are Ripple UI unless this context identifies app: ripple or the user explicitly selected a Ripple UI skill.\n\n```json\n{json}\n```"
    )
}

pub(crate) fn render_client_context(client_context: Option<&Value>) -> Option<String> {
    let client_context = client_context?;
    let raw_json = serde_json::to_string(client_context).unwrap_or_else(|_| "{}".to_string());
    let summary = summarize_client_context(client_context);
    Some(format!(
        "Client-provided software and device state. Treat these values as structured facts from the embedding host app; do not ask for a screenshot when the requested state is present here.\n\n## State Summary\n{}\n\n## Raw Client Context JSON\n```json\n{}\n```",
        summary,
        raw_json
    ))
}

fn summarize_client_context(client_context: &Value) -> String {
    let mut lines = Vec::new();
    push_string_value(
        &mut lines,
        client_context,
        "/schema_version",
        "schema_version",
    );
    push_string_value(
        &mut lines,
        client_context,
        "/software/host_app/app_id",
        "software.host_app.app_id",
    );
    push_string_value(
        &mut lines,
        client_context,
        "/software/host_app/name",
        "software.host_app.name",
    );
    push_string_value(
        &mut lines,
        client_context,
        "/software/screen/screen_id",
        "software.screen.screen_id",
    );
    push_string_value(
        &mut lines,
        client_context,
        "/software/screen/title",
        "software.screen.title",
    );
    push_string_value(
        &mut lines,
        client_context,
        "/software/selection/type",
        "software.selection.type",
    );
    push_string_value(
        &mut lines,
        client_context,
        "/software/selection/display_name",
        "software.selection.display_name",
    );

    if let Some(devices) = client_context.get("devices").and_then(Value::as_array) {
        for (index, device) in devices.iter().enumerate() {
            let label = device
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("device[{index}]"));
            push_device_string(&mut lines, device, &label, "/kind", "kind");
            push_device_string(
                &mut lines,
                device,
                &label,
                "/identity/manufacturer",
                "identity.manufacturer",
            );
            push_device_string(
                &mut lines,
                device,
                &label,
                "/identity/model",
                "identity.model",
            );
            push_device_string(
                &mut lines,
                device,
                &label,
                "/connection/state",
                "connection.state",
            );
            push_device_string(
                &mut lines,
                device,
                &label,
                "/connection/transport",
                "connection.transport",
            );
            if let Some(state) = device.get("state").and_then(Value::as_object) {
                for (key, value) in state {
                    lines.push(format!(
                        "- {label}.state.{key}: {}",
                        render_summary_value(value)
                    ));
                }
            }
        }
    }

    if lines.is_empty() {
        "(no compact state fields detected; inspect the raw JSON below)".to_string()
    } else {
        lines.join("\n")
    }
}

fn push_string_value(lines: &mut Vec<String>, root: &Value, pointer: &str, label: &str) {
    if let Some(value) = root
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("- {label}: {value}"));
    }
}

fn push_device_string(
    lines: &mut Vec<String>,
    device: &Value,
    label: &str,
    pointer: &str,
    key: &str,
) {
    if let Some(value) = device
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("- {label}.{key}: {value}"));
    }
}

fn render_summary_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => "null".to_string(),
        _ => serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

fn connector_manifest(skill_options: &SkillManifestOptions) -> String {
    let connected = |value| {
        if value {
            "connected"
        } else {
            "not_connected"
        }
    };
    let connector = |name: &str| {
        connected(
            skill_options
                .connector_statuses
                .get(name)
                .copied()
                .unwrap_or(false),
        )
    };
    [
        ("google_workspace", connector("google_workspace")),
        ("notion", connector("notion")),
        ("feishu", connector("feishu")),
        ("bilibili", connector("bilibili")),
        ("openai_codex", "connected"),
        ("codex_image_generation", "disabled_by_default"),
        ("codex_image_input", "connected"),
        ("codex_web_search", "connected"),
    ]
    .into_iter()
    .map(|(name, status)| format!("- {name}: {status}"))
    .collect::<Vec<_>>()
    .join("\n")
}
