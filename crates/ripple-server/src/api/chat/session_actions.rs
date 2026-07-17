use serde_json::Value;

use super::connector_auth::{
    start_model_connector_auth_for_chat, ConnectorAuthDecision, ModelConnectorAuthRequest,
};
use super::input::ExtractedControlAction;
use crate::api::ApiError;
use crate::sessions::SessionRecord;
use crate::state::AppState;

pub(crate) async fn handle_session_control_action(
    state: &AppState,
    user_id: &str,
    session: &mut SessionRecord,
    control_action: &ExtractedControlAction,
    request_base_url: Option<&str>,
) -> Result<ConnectorAuthDecision, ApiError> {
    match action_type(control_action.action.get("type")) {
        Some("connector.auth.start") => {
            let connector = control_action
                .action
                .get("connector")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ApiError::bad_request("connector is required"))?;
            let request = ModelConnectorAuthRequest {
                connector: connector.to_string(),
                force_reauth: control_action
                    .action
                    .get("force_reauth")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                source: control_action
                    .action
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
            };
            start_model_connector_auth_for_chat(
                state,
                user_id,
                session,
                &request,
                "",
                request_base_url,
                false,
            )
            .await
        }
        Some(other) => Err(ApiError::bad_request(format!(
            "Unsupported session control action {other:?}"
        ))),
        None => Err(ApiError::bad_request("control action type is required")),
    }
}

fn action_type(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
