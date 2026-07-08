use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::openapi::security::{ApiKey, ApiKeyValue, HttpAuthScheme, HttpBuilder, SecurityScheme};
use utoipa::openapi::OpenApi;
use utoipa::{Modify, OpenApi as DeriveOpenApi, ToSchema};
use utoipa_swagger_ui::{Config, SwaggerUi, Url};

#[derive(DeriveOpenApi)]
#[openapi(
    info(
        title = "Ripple Server API",
        version = "0.1.0",
        description = "OpenAPI contract for Ripple Server control-plane endpoints."
    ),
    components(
        schemas(
            ApiErrorEnvelope,
            ApiErrorFields,
            ConfirmationRequest,
            GenericJsonObject,
            PaginatedJsonResponse,
            SseEvent
        )
    ),
    tags(
        (name = "health", description = "Server health and readiness endpoints"),
        (name = "auth", description = "Browser user authentication endpoints"),
        (name = "models", description = "Model and runtime metadata"),
        (name = "chat", description = "OpenAI-compatible chat bridge"),
        (name = "sessions", description = "Ripple session lifecycle endpoints"),
        (name = "task-sessions", description = "Task Session, TaskSpec, confirmation, and task run endpoints"),
        (name = "tasks", description = "Legacy session-linked task read projection; /v1/tasks is not registered"),
        (name = "runs", description = "Codex run lifecycle endpoints"),
        (name = "users", description = "Current user profile and usage endpoints"),
        (name = "sandboxes", description = "User sandbox management endpoints"),
        (name = "workspace", description = "Workspace filesystem endpoints"),
        (name = "documents", description = "Workspace document catalog endpoints"),
        (name = "capabilities", description = "Unified runtime capability catalog"),
        (name = "skills", description = "User and shared skill endpoints"),
        (name = "connectors", description = "User connector management endpoints")
    ),
    modifiers(&SecurityAddon)
)]
struct BaseOpenApi;

pub fn base_openapi() -> OpenApi {
    BaseOpenApi::openapi()
}

pub fn docs_router<S>(openapi: OpenApi, try_it_out_enabled: bool) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::from(
        SwaggerUi::new("/docs")
            .url(Url::new("Ripple Server API", "/openapi.json"), openapi)
            .config(
                Config::new([Url::new("Ripple Server API", "/openapi.json")])
                    .try_it_out_enabled(try_it_out_enabled),
            ),
    )
}

struct SecurityAddon;

impl Modify for SecurityAddon {
    fn modify(&self, openapi: &mut OpenApi) {
        if let Some(components) = openapi.components.as_mut() {
            components.add_security_scheme(
                "bearerAuth",
                SecurityScheme::Http(
                    HttpBuilder::new()
                        .scheme(HttpAuthScheme::Bearer)
                        .bearer_format("API key or user session token")
                        .build(),
                ),
            );
            components.add_security_scheme(
                "apiKeyAuth",
                SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::with_description(
                    "X-API-Key",
                    "Service API key for trusted upstream callers.",
                ))),
            );
        }
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ApiErrorEnvelope {
    pub detail: Value,
    pub error: ApiErrorFields,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ApiErrorFields {
    pub code: String,
    pub message: String,
    pub request_id: String,
    pub details: Value,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ConfirmationRequest {
    pub confirm: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct GenericJsonObject {
    #[schema(value_type = Object)]
    pub value: Value,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PaginatedJsonResponse {
    #[schema(value_type = Vec<Object>)]
    pub items: Vec<Value>,
    pub count: usize,
    pub total: usize,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct SseEvent {
    pub event_version: Option<u32>,
    pub r#type: Option<String>,
    #[schema(value_type = Object)]
    pub data: Option<Value>,
}
