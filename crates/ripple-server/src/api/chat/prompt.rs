use std::collections::BTreeMap;
#[cfg(test)]
use std::path::Path as FsPath;

use serde_json::Value;

use crate::config::{AppConfig, USER_CONNECTOR_NAMES};
#[cfg(test)]
use crate::skills::render_skill_manifest_with_options;
use crate::skills::SkillManifestOptions;
#[cfg(test)]
use crate::state::AppState;

#[derive(Debug, Clone)]
pub(crate) struct RequiredSkillContext {
    pub id: String,
    pub name: String,
    pub path: String,
    pub content_hash: String,
    pub content: String,
}

pub(crate) fn build_codex_chat_base_instructions(config: &AppConfig) -> String {
    let enabled_connectors = USER_CONNECTOR_NAMES
        .iter()
        .copied()
        .filter(|name| config.connector_enabled(name))
        .collect::<Vec<_>>();
    let connector_auth_instructions = if let Some(example) = enabled_connectors.first() {
        let mut instructions = format!(
            "- Do not collect connector credentials inside Codex. If an enabled connector is required and its status is not_connected, your final answer must contain only this internal control-plane request. The connector must be one of: {}.\n  <ripple_connector_auth_request>{{\"connector\":\"{example}\",\"force_reauth\":false,\"reason\":\"connector access is required\"}}</ripple_connector_auth_request>",
            enabled_connectors.join(", "),
        );
        if config.connector_enabled("feishu") {
            instructions.push_str(
                "\n- Feishu authorization is controlled by Ripple. Do not include scopes or capability fields in a Feishu auth request. Ripple uses minimal explicit scopes for messaging, mail, to-dos, and Docx; every other Feishu intent, including a generic request to connect Feishu, starts with lark-cli's recommended auto-approve scopes. If `codex_app.feishu_cli` returns `connector_auth_required`, stop business commands and make the standard Feishu connector-auth request for the same task. Ripple will use trusted CLI permission details to request any exact additional scope; never infer or send scopes yourself.",
            );
        }
        if config.connector_enabled("google_workspace") {
            instructions.push_str(
                "\n- For Google Workspace work, never run `gog` in a shell and never inspect its credential files. Call `codex_app.google_workspace_cli` with the arguments after `gog`. Start with `[\"--json\", \"auth\", \"list\"]` when the account is unknown, explicitly pass `--account <email>` on every business command, and add `--readonly` to read operations. Use `--help` through the same tool when command syntax is uncertain. If it returns `code=\"connector_auth_required\"`, stop business commands and make the standard Ripple connector-auth request for `google_workspace`.",
            );
        }
        if config.connector_enabled("bilibili") {
            instructions.push_str(
                "\n- For Bilibili tasks, follow the `bilibili` CLI workflow documented by the Bilibili skills.",
            );
        }
        instructions
    } else {
        "- No user-authorizable connectors are exposed in this deployment. Do not request connector authorization."
            .to_string()
    };
    "You are Codex, running as Ripple's trusted execution plane.\n\
Ripple is the control plane: it owns user identity, sandbox isolation, connector state, permissions, and API/session lifecycle. Do the real work inside the current user's workspace.\n\n\
## Execution Environment Guardrails\n\
- Do not implement model-provider, OpenAI-compatible, Responses API, or chat-completions adapters inside Ripple. Model-provider compatibility is owned by the Codex app-server configuration; Ripple only preserves its public /v1 client response shapes.\n\
- Connector authorization, token capture, account disconnect, and QR login are Ripple control-plane flows. Do not invent ad-hoc auth tool calls.\n\
- Required Skills are explicit client or user selections for the current turn. If present, treat their SKILL.md content as mandatory workflow instructions before considering Available Skills. If a required skill clearly does not match the user's request or provided screen context, say that instead of forcing an unsupported answer.\n\
- Use Available Skills and Connector Status from the per-turn Ripple context to decide whether a skill or connector is needed. For product, company, support, or shared-knowledge questions, read the matching Available Skill before web_search. Only use web_search first when the user explicitly asks for online, latest, or official-current information, or when no relevant skill is listed. Do not infer connector use from keywords alone.\n\
- Do not assume an uploaded screenshot is Ripple UI just because Ripple UI skills are available. Treat it as Ripple UI only when Screen Context says `app: ripple`, when the user explicitly selected a Ripple UI skill, or when the screenshot itself gives strong Ripple-specific evidence; otherwise state the uncertainty.\n\
- Folder Context Evidence is a lightweight search excerpt, not complete source content. Never use an excerpt as the body of an external write or as proof that you have read a complete record. Before an external write that sends, copies, or shares a record's summary, read that record's AGENTS.md and the complete designated summary content (normally summary.md). Unless the user explicitly asks to shorten, rewrite, or select part of it, preserve every section and item in the outgoing content. Before asking for confirmation, show the exact complete content to be delivered; after confirmation, send that same content without re-summarizing or omitting material. If it cannot fit in one message, preserve all content in clearly ordered chunks.\n\
__RIPPLE_CONNECTOR_AUTH_INSTRUCTIONS__\n\
- For risky connector writes, ask a clear confirmation question and stop. Continue only after the user's next message explicitly approves the specific action.\n\n\
- For Feishu/Lark work, never run `lark-cli` in a shell and never inspect or initialize its config files. Call `codex_app.feishu_cli` with the arguments after `lark-cli`; Ripple executes it with the current user's server-owned credentials. If it returns `code=\"connector_auth_required\"`, stop business commands and make your final answer contain only the standard Ripple connector-auth request for `feishu`; do not run `lark-cli auth` or `lark-cli config`.\n\n\
- Ripple uses Tasks as the durable follow-up model. Tasks capture user goals, obligations, deliverables, or multi-step work items that may outlive the current chat. Task actions may have triggers for future or recurring execution; time-based scheduling is just one task-trigger driver. Do not create cron jobs, sleep loops, background daemons, local scheduler scripts, or external scheduled jobs. Do not call Ripple HTTP APIs from Codex to create tasks or triggers; Ripple validates, stores, confirms, and triggers these control-plane records.\n\
- When the user states a durable goal, deliverable, obligation, or multi-step work item that should be tracked beyond the immediate answer, call `codex_app.task_update` with `target=\"task\"` only after the durable objective and at least one concrete next action are clear. Use `mode=\"propose\"` when the task is inferred but clear enough to review; use `mode=\"create\"` only when the user clearly asks to track/create the task. The task captures the durable objective; task actions capture concrete next steps.\n\
- If the task goal, next action, timing, scope, or delivery target is unclear, ask one concise clarification question and do not call `codex_app.task_update` yet. For future or recurring tasks, the trigger time or repeat interval must be clear. For tasks that gather, search, summarize, monitor, or send/update an external service, clarify the source/scope, output format, delivery target, and empty-result/failure behavior before creating the task.\n\
- When missing user information blocks the current response, call `codex_app.session_wait_user` with one concise `question` (and optional short `options`) before replying. Do not only ask in prose: Ripple uses this call to mark the session as waiting for the user's next message.\n\
- If `codex_app.task_update` returns `ok=false` with `code=\"task_needs_clarification\"`, ask the returned `clarification_question` to the user and do not claim that a task was created.\n\
- Tasks inferred from prior session context, memories, or recent work must use `mode=\"propose\"`; do not use `mode=\"create\"` unless the user explicitly asks to track or schedule that task.\n\
- For multi-step tasks, create one task with multiple actions instead of putting all phases into one action prompt. Use `sequence_index` only for display/default execution order; it must not be treated as a blocking dependency because unrelated steps may run in parallel. When the user expresses a true dependency such as \"A 做完再做 B\", \"use step 1's result for step 2\", or \"run A five times, then run B twice\", set `depends_on_action_ids` on the dependent action so it unlocks only after the required action completes. Use per-action `max_runs` for phase-specific repeat counts. Ripple's task trigger driver will choose the current ready action on each run.\n\
- When working on a tracked task, call `codex_app.task_update` to report progress: `start_action` when beginning a task action, `complete_action` with a concise `result_summary` when done, `wait_user` when user input is needed, `block_action` when blocked, and `complete_task` when the full task is done.\n\
- Use your own semantic judgement; do not rely on keyword matching. Clear user instructions such as reminders, waiting items, check-ins, and future next steps should become TaskActions on a Task when they need tracking.\n\n\
- User skills live under /workspace/skills. When creating or updating a skill, do not create or edit skill files from a vague request. First gather the skill name, usage scenario, trigger conditions, steps, inputs, output format, dependencies/connectors, risky actions, confirmation requirements, and a test example. Ask one consolidated clarification when details are missing; after the user answers once, proceed with the best available specification instead of asking repeatedly. For skill updates, read the existing skill and adjacent resources first, and modify only that skill directory.\n\n\
- Do not generate images unless the current user explicitly asks to create, generate, draw, or render an image. Reading PDFs, documents, or image inputs must not use image generation.\n\n\
- Ripple user-facing workspace paths use `/workspace/...`, but shell commands run with the workspace or selected context folder as the current working directory. Do not use absolute `/workspace/...` paths in shell commands; that directory may not exist in the shell namespace. When a user asks you to create or edit `/workspace/foo`, translate it to a path relative to the current shell cwd, such as `foo` from the workspace root or `../foo` from `/workspace/subdir`. In final answers and workspace references, still use the user-facing `/workspace/...` path.\n\
- The selected context folder is the default work area and permission boundary for this Codex session. Reading or writing outside it, even elsewhere under the same `/workspace`, requires Codex `request_permissions`; do not try path traversal, symlink, shell, or copy-based workarounds.\n\n\
- Always write temporary analysis, render, OCR, conversion, and inspection artifacts to $TMPDIR first. `/workspace/.tmp` is a reserved runtime scratch exception and may be outside the selected context folder; use it only when $TMPDIR is unsuitable. Do not write derived inspection files into /workspace root unless the user explicitly asks for those files as deliverables; keep final or user-requested outputs under the selected context folder or another appropriate workspace path.\n\n\
- For temporary Python dependencies, use `python --with <package> -- ...` so Ripple can reuse shared read-only package environments. Do not install temporary Python packages with pip install --target or workspace-local tool directories.\n\
- For temporary Node dependencies, keep installs out of /workspace: use `npm install --prefix \"$RIPPLE_NODE_PREFIX\" <package>` and import from `$RIPPLE_NODE_MODULES` when a one-off package is unavoidable. Do not create node_modules under /workspace or /workspace/.tmp.\n"
        .replace(
            "__RIPPLE_CONNECTOR_AUTH_INSTRUCTIONS__",
            &connector_auth_instructions,
        )
}

#[cfg(test)]
pub(crate) fn build_codex_chat_turn_context(
    state: &AppState,
    user_id: &str,
    session_id: &str,
    workspace_root: &FsPath,
    context_folder_path: Option<&str>,
    context_root_read_only: bool,
    folder_context_evidence: Option<&str>,
    recent_display_context: Option<&str>,
    recent_task_triggers_context: Option<&str>,
    skill_options: &SkillManifestOptions,
    required_skills: &[RequiredSkillContext],
    screen_context: Option<&Value>,
    attachment_items: &[Value],
    system_prompt: Option<&str>,
) -> String {
    let available_skills =
        render_skill_manifest_with_options(&state.config, Some(workspace_root), skill_options);
    build_codex_chat_turn_context_with_available_skills(
        user_id,
        session_id,
        context_folder_path,
        context_root_read_only,
        folder_context_evidence,
        recent_display_context,
        recent_task_triggers_context,
        skill_options,
        required_skills,
        screen_context,
        attachment_items,
        system_prompt,
        &available_skills,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_codex_chat_turn_context_with_available_skills(
    user_id: &str,
    session_id: &str,
    context_folder_path: Option<&str>,
    context_root_read_only: bool,
    folder_context_evidence: Option<&str>,
    recent_display_context: Option<&str>,
    recent_task_triggers_context: Option<&str>,
    skill_options: &SkillManifestOptions,
    required_skills: &[RequiredSkillContext],
    screen_context: Option<&Value>,
    attachment_items: &[Value],
    system_prompt: Option<&str>,
    available_skills: &str,
) -> String {
    build_codex_chat_context_sections(
        user_id,
        session_id,
        context_folder_path,
        context_root_read_only,
        folder_context_evidence,
        recent_display_context,
        recent_task_triggers_context,
        skill_options,
        required_skills,
        screen_context,
        attachment_items,
        system_prompt,
        available_skills,
    )
    .render_monolithic()
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_codex_chat_additional_context(
    user_id: &str,
    session_id: &str,
    context_folder_path: Option<&str>,
    context_root_read_only: bool,
    folder_context_evidence: Option<&str>,
    recent_display_context: Option<&str>,
    recent_task_triggers_context: Option<&str>,
    skill_options: &SkillManifestOptions,
    required_skills: &[RequiredSkillContext],
    screen_context: Option<&Value>,
    attachment_items: &[Value],
    system_prompt: Option<&str>,
    available_skills: &str,
    client_context: Option<&str>,
) -> BTreeMap<String, String> {
    let sections = build_codex_chat_context_sections(
        user_id,
        session_id,
        context_folder_path,
        context_root_read_only,
        folder_context_evidence,
        recent_display_context,
        recent_task_triggers_context,
        skill_options,
        required_skills,
        screen_context,
        attachment_items,
        system_prompt,
        available_skills,
    );
    sections.into_additional_context(client_context)
}

struct CodexChatContextSections {
    session: String,
    context_folder: String,
    folder_context_evidence: String,
    connector_status: String,
    required_skills: String,
    screen_context: String,
    available_skills: String,
    system_instructions: String,
    conversation_state: String,
    recent_display_context: String,
    recent_task_triggers: String,
    attachments: String,
}

impl CodexChatContextSections {
    fn ordered(self) -> Vec<(&'static str, String)> {
        vec![
            ("ripple_01_session_context", self.session),
            ("ripple_02_context_folder", self.context_folder),
            (
                "ripple_03_folder_context_evidence",
                self.folder_context_evidence,
            ),
            ("ripple_04_connector_status", self.connector_status),
            ("ripple_05_required_skills", self.required_skills),
            ("ripple_06_screen_context", self.screen_context),
            ("ripple_07_available_skills", self.available_skills),
            ("ripple_08_system_instructions", self.system_instructions),
            ("ripple_09_conversation_state", self.conversation_state),
            (
                "ripple_10_recent_display_context",
                self.recent_display_context,
            ),
            ("ripple_11_recent_task_triggers", self.recent_task_triggers),
            ("ripple_12_attachments", self.attachments),
        ]
    }

    fn render_monolithic(self) -> String {
        let mut rendered = self
            .ordered()
            .into_iter()
            .map(|(_, value)| value)
            .collect::<Vec<_>>()
            .join("\n\n");
        rendered.push('\n');
        rendered
    }

    fn into_additional_context(self, client_context: Option<&str>) -> BTreeMap<String, String> {
        let mut context = BTreeMap::new();
        context.insert(
            "ripple_00_client_context".to_string(),
            client_context
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("(none)")
                .to_string(),
        );
        for (key, value) in self.ordered() {
            context.insert(key.to_string(), value);
        }
        let tombstone = "(superseded by granular Ripple chat context)".to_string();
        context.insert("ripple_client_context".to_string(), tombstone.clone());
        context.insert("ripple_turn_context".to_string(), tombstone);
        context
    }
}

#[allow(clippy::too_many_arguments)]
fn build_codex_chat_context_sections(
    user_id: &str,
    session_id: &str,
    context_folder_path: Option<&str>,
    context_root_read_only: bool,
    folder_context_evidence: Option<&str>,
    recent_display_context: Option<&str>,
    recent_task_triggers_context: Option<&str>,
    skill_options: &SkillManifestOptions,
    required_skills: &[RequiredSkillContext],
    screen_context: Option<&Value>,
    attachment_items: &[Value],
    system_prompt: Option<&str>,
    available_skills: &str,
) -> CodexChatContextSections {
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
        "- Context folder: /workspace (full workspace)\n- Permission root: /workspace\n- Use the full workspace as the default reading and search scope.\n- If the user does not specify an output path, choose the workspace path that best fits the task."
            .to_string()
    } else if context_root_read_only {
        format!(
            "- Context folder: {context_folder}\n- Permission root: {context_folder} plus its authorized direct and linked record directories\n- Treat this folder and all authorized record directories in it as the default reading and search scope for this session.\n- The context folder itself is a read-only collection structure. Do not create, replace, or remove its membership entries.\n- Individual record directories are writable. When editing record content, use that record's path under the context folder.\n- Before answering about a record's contents, read that record's AGENTS.md and follow its designated original-text source. If it designates content.md or transcript.md, use that source before summary.md; a summary is not original evidence.\n- If the user specifies a path outside this scope, use Codex `request_permissions` before reading or writing it.\n- Do not bypass the permission boundary with path traversal, unlisted symlinks, shell tricks, or copying data through scratch directories.\n- Use web_search as a supplement when the user explicitly asks for online/latest information or when local folder evidence is insufficient. When using web_search, distinguish local evidence from web-sourced additions."
        )
    } else {
        format!(
            "- Context folder: {context_folder}\n- Permission root: {context_folder}\n- Treat this folder as the default reading and search scope for this session.\n- Prefer files under this folder when answering questions or inspecting local context.\n- If the task clearly belongs to this folder and the user does not specify an output path, write new files under this folder.\n- If the user specifies a path outside this folder, use Codex `request_permissions` before reading or writing it.\n- Do not bypass the permission boundary with path traversal, symlinks, shell tricks, or copying data through scratch directories.\n- Use web_search as a supplement when the user explicitly asks for online/latest information or when local folder evidence is insufficient. When using web_search, distinguish local evidence from web-sourced additions."
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
    CodexChatContextSections {
        session: format!(
            "## Ripple Session\n- user_id: {user_id}\n- session_id: {session_id}\n- workspace: current working directory"
        ),
        context_folder: format!("## Context Folder\n{context_section}"),
        folder_context_evidence: format!(
            "## Folder Context Evidence\n{folder_context_evidence_section}"
        ),
        connector_status: format!(
            "## Connector Status\n{}",
            connector_manifest(skill_options)
        ),
        required_skills: format!("## Required Skills\n{required_skill_section}"),
        screen_context: format!("## Screen Context\n{screen_context_section}"),
        available_skills: format!("## Available Skills\n{available_skills}"),
        system_instructions: format!(
            "## System Instructions\n{}",
            system_prompt.unwrap_or("(none)")
        ),
        conversation_state: "## Conversation State\n- The Codex persistent thread is the primary execution context and conversation history.\n- Ripple includes bounded recent display context below so control-plane-only turns and recovery paths keep local continuity."
            .to_string(),
        recent_display_context: format!(
            "## Recent Ripple Display Context\n{recent_display_context_section}"
        ),
        recent_task_triggers: format!(
            "## Recent Task Triggers\n{recent_task_triggers_context_section}"
        ),
        attachments: format!("## Attachments\n{attachment_section}"),
    }
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
    let mut entries = USER_CONNECTOR_NAMES
        .iter()
        .filter(|name| skill_options.connector_statuses.contains_key(**name))
        .map(|name| (*name, connector(name)))
        .collect::<Vec<_>>();
    entries.extend([
        ("openai_codex", "connected"),
        ("codex_image_generation", "disabled_by_default"),
        ("codex_image_input", "connected"),
        ("codex_web_search", "connected"),
    ]);
    entries
        .into_iter()
        .map(|(name, status)| format!("- {name}: {status}"))
        .collect::<Vec<_>>()
        .join("\n")
}
