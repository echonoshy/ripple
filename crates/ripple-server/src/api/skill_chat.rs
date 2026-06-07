use serde_json::{json, Value};

use crate::api::schedule_chat::ScheduleChatDecision;
use crate::api::skills::{create_user_skill_draft, SkillDraftInput};
use crate::api::ApiError;
use crate::sessions::SessionRecord;
use crate::state::AppState;

const SKILL_DETAILS_MISSING_FIELD: &str = "skill_details";
const CONFIRM_WORDS: &[&str] = &[
    "确认",
    "确认创建",
    "创建",
    "确定",
    "可以",
    "好的",
    "好",
    "yes",
    "ok",
];
const CANCEL_WORDS: &[&str] = &["取消", "放弃", "不要", "不用", "先不要", "cancel", "no"];

pub(crate) fn maybe_handle_skill_chat(
    state: &AppState,
    user_id: &str,
    session: &SessionRecord,
    user_input: &str,
) -> Result<Option<ScheduleChatDecision>, ApiError> {
    if let Some(pending) = session
        .pending_schedule_request
        .as_ref()
        .filter(|value| value.get("type").and_then(Value::as_str) == Some("skill_draft"))
    {
        return handle_pending_skill_draft(state, user_id, pending, user_input).map(Some);
    }

    if !is_skill_save_intent(user_input) {
        return Ok(None);
    }
    let workflow = skill_workflow_text(user_input);

    if let Some(clarification) = skill_detail_clarification(&workflow) {
        return Ok(Some(awaiting_skill_decision(
            skill_clarification_event(&clarification),
            Some(skill_draft_pending_value(
                user_input,
                &workflow,
                &clarification,
            )),
        )));
    }

    let skill = create_skill_from_workflow(state, user_id, &workflow)?;
    Ok(Some(idle_skill_decision(skill_draft_created_event(skill))))
}

fn handle_pending_skill_draft(
    state: &AppState,
    user_id: &str,
    pending: &Value,
    user_input: &str,
) -> Result<ScheduleChatDecision, ApiError> {
    if is_skill_cancellation(user_input) {
        return Ok(ScheduleChatDecision {
            event: skill_cancelled_event("已取消创建这个能力草稿。"),
            status: "idle".to_string(),
            clear_pending_schedule: true,
            pending_schedule_request: None,
        });
    }

    if is_skill_confirmation(user_input) {
        let clarification = pending
            .get("clarification_question")
            .and_then(Value::as_str)
            .unwrap_or("这个能力还缺少信息，请先补充。");
        return Ok(awaiting_skill_decision(
            skill_clarification_event(clarification),
            Some(pending.clone()),
        ));
    }

    let workflow = combine_skill_draft_followup(pending, user_input);
    let skill = create_skill_from_workflow(state, user_id, &workflow)?;
    Ok(ScheduleChatDecision {
        event: skill_draft_created_event(skill),
        status: "idle".to_string(),
        clear_pending_schedule: true,
        pending_schedule_request: None,
    })
}

fn create_skill_from_workflow(
    state: &AppState,
    user_id: &str,
    workflow: &str,
) -> Result<Value, ApiError> {
    create_user_skill_draft(
        state,
        user_id,
        SkillDraftInput {
            name: Some("saved-conversation-skill".to_string()),
            display_name: Some("Saved Conversation Skill".to_string()),
            description: workflow.to_string(),
            when_to_use: Some("When the user asks to run this saved workflow.".to_string()),
            steps: vec![workflow.to_string()],
            output_format: Some("Follow the saved workflow and show a concise result.".to_string()),
            kind: Some("text".to_string()),
            runtime: None,
            entry: None,
            python_packages: Vec::new(),
            script: None,
            requires_connectors: Vec::new(),
            requires_user_confirmation: false,
            test_example: None,
        },
        true,
    )
}

fn is_skill_save_intent(input: &str) -> bool {
    let lowered = input.to_lowercase();
    lowered.contains("保存成一个能力")
        || lowered.contains("保存为一个能力")
        || lowered.contains("保存成能力")
        || lowered.contains("save as a skill")
        || lowered.contains("save this as a skill")
}

fn skill_workflow_text(input: &str) -> String {
    let trimmed = input.trim();
    for marker in ["：", ":", "能力"] {
        if let Some((_, rest)) = trimmed.split_once(marker) {
            let rest = rest.trim();
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
    trimmed.to_string()
}

fn skill_detail_clarification(workflow: &str) -> Option<String> {
    if !should_request_skill_details(workflow) {
        return None;
    }
    Some(
        "这个能力描述还太粗，先补充一些信息再保存，避免以后触发错或执行效果不稳定。请一次性说明：\n\
- 使用场景：什么时候应该使用这个 skill，什么时候不应该用。\n\
- 输入和步骤：用户会给什么信息，Agent 应该按哪些步骤做。\n\
- 输出格式：最终回复或文件应该长什么样。\n\
- 依赖：是否需要 Python 包、文件、网页搜索，或飞书/Google/Notion/Bilibili 等服务。\n\
- 风险和确认：是否会发送消息、改文件、删数据、调用外部服务，哪些动作必须先确认。\n\
- 测试样例：给一个典型请求和期望结果。"
            .to_string(),
    )
}

fn should_request_skill_details(workflow: &str) -> bool {
    let text = workflow.trim().to_ascii_lowercase();
    if text.chars().count() < 18 {
        return true;
    }
    let detail_buckets = [
        contains_any(
            &text,
            &[
                "当",
                "什么时候",
                "场景",
                "when",
                "use",
                "每次",
                "每周",
                "每天",
                "如果",
            ],
        ),
        contains_any(
            &text,
            &[
                "步骤", "先", "然后", "再", "最后", "step", "流程", "检查", "整理", "总结",
            ],
        ),
        contains_any(
            &text,
            &[
                "输出", "格式", "列表", "表格", "文件", "回复", "result", "format", "列",
            ],
        ),
        contains_any(
            &text,
            &[
                "python",
                "包",
                "依赖",
                "飞书",
                "google",
                "notion",
                "bilibili",
                "网页",
                "搜索",
                "connector",
            ],
        ),
        contains_any(
            &text,
            &[
                "确认",
                "风险",
                "发送",
                "删除",
                "修改",
                "写入",
                "外部",
                "高风险",
                "confirm",
                "risk",
            ],
        ),
        contains_any(&text, &["样例", "例子", "例如", "test", "example"]),
    ];
    let detail_count = detail_buckets
        .iter()
        .filter(|has_detail| **has_detail)
        .count();
    detail_count < 2
}

fn contains_any(text: &str, markers: &[&str]) -> bool {
    markers.iter().any(|marker| text.contains(marker))
}

fn skill_draft_pending_value(
    original_user_input: &str,
    workflow: &str,
    clarification: &str,
) -> Value {
    json!({
        "type": "skill_draft",
        "original_user_input": original_user_input.trim(),
        "missing_fields": [SKILL_DETAILS_MISSING_FIELD],
        "clarification_question": clarification,
        "partial_skill": {
            "workflow": workflow.trim()
        }
    })
}

fn combine_skill_draft_followup(pending: &Value, user_input: &str) -> String {
    let original = pending
        .pointer("/partial_skill/workflow")
        .and_then(Value::as_str)
        .or_else(|| pending.get("original_user_input").and_then(Value::as_str))
        .unwrap_or("")
        .trim();
    let followup = user_input.trim();
    format!("{original}\n\n补充信息：{followup}")
}

fn is_skill_confirmation(text: &str) -> bool {
    let normalized = normalize_reply(text);
    CONFIRM_WORDS.iter().any(|word| normalized == *word)
}

fn is_skill_cancellation(text: &str) -> bool {
    let normalized = normalize_reply(text);
    CANCEL_WORDS.iter().any(|word| normalized == *word)
}

fn normalize_reply(text: &str) -> String {
    text.trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| {
            !ch.is_whitespace()
                && !matches!(
                    ch,
                    '。' | '.'
                        | '!'
                        | '！'
                        | '?'
                        | '？'
                        | ','
                        | '，'
                        | ';'
                        | '；'
                        | ':'
                        | '：'
                        | '"'
                        | '\''
                        | '“'
                        | '”'
                        | '‘'
                        | '’'
                )
        })
        .collect()
}

fn skill_draft_created_event(skill: Value) -> Value {
    json!({
        "type": "skill_draft_created",
        "message": "已创建能力草稿。检查并启用后，我才会在后续任务中使用它。",
        "skill": skill
    })
}

fn skill_clarification_event(message: &str) -> Value {
    json!({
        "type": "skill_clarification_required",
        "message": message,
        "question": message,
        "options": []
    })
}

fn skill_cancelled_event(message: &str) -> Value {
    json!({
        "type": "skill_cancelled",
        "message": message
    })
}

fn idle_skill_decision(event: Value) -> ScheduleChatDecision {
    ScheduleChatDecision {
        event,
        status: "idle".to_string(),
        clear_pending_schedule: false,
        pending_schedule_request: None,
    }
}

fn awaiting_skill_decision(
    event: Value,
    pending_schedule_request: Option<Value>,
) -> ScheduleChatDecision {
    ScheduleChatDecision {
        event,
        status: "awaiting_user_input".to_string(),
        clear_pending_schedule: false,
        pending_schedule_request,
    }
}
