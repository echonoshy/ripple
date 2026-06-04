use serde_json::{json, Value};

use crate::api::schedule_chat::ScheduleChatDecision;
use crate::api::skills::{create_user_skill_draft, SkillDraftInput};
use crate::api::ApiError;
use crate::state::AppState;

pub(crate) fn maybe_handle_skill_chat(
    state: &AppState,
    user_id: &str,
    user_input: &str,
) -> Result<Option<ScheduleChatDecision>, ApiError> {
    if !is_skill_save_intent(user_input) {
        return Ok(None);
    }
    let workflow = skill_workflow_text(user_input);
    let skill = create_user_skill_draft(
        state,
        user_id,
        SkillDraftInput {
            name: Some("saved-conversation-skill".to_string()),
            display_name: Some("Saved Conversation Skill".to_string()),
            description: workflow.clone(),
            when_to_use: Some("When the user asks to run this saved workflow.".to_string()),
            steps: vec![workflow.clone()],
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
    )?;
    Ok(Some(ScheduleChatDecision {
        event: skill_draft_created_event(skill),
        status: "idle".to_string(),
        clear_pending_schedule: false,
        pending_schedule_request: None,
    }))
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

fn skill_draft_created_event(skill: Value) -> Value {
    json!({
        "type": "skill_draft_created",
        "message": "已创建能力草稿。测试并启用后，我才会在后续任务中使用它。",
        "skill": skill
    })
}
