#!/usr/bin/env node

import process from "node:process";

const DEFAULT_API_URL = "http://127.0.0.1:8810/v1";
const DEFAULT_USER_ID = "mvp_host_demo";
const DEFAULT_MODEL = "codex-high";
const DEFAULT_PROMPT =
  "请根据我传入的软件页面上下文和耳机状态，解释当前页面是什么、耳机现在是什么状态，以及我接下来可以做什么。";

export function normalizeApiUrl(value = DEFAULT_API_URL) {
  const trimmed = String(value || DEFAULT_API_URL).trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function nextArg(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(args = process.argv.slice(2), env = process.env) {
  const options = {
    apiUrl: normalizeApiUrl(env.RIPPLE_API_URL || DEFAULT_API_URL),
    apiKey: env.RIPPLE_API_KEY || "",
    userId: env.RIPPLE_USER_ID || DEFAULT_USER_ID,
    model: env.RIPPLE_MODEL || DEFAULT_MODEL,
    prompt: env.RIPPLE_PROMPT || DEFAULT_PROMPT,
    sessionId: env.RIPPLE_SESSION_ID || `client-context-demo-${Date.now()}`,
    stream: env.RIPPLE_STREAM === "false" ? false : true,
    showRequest: env.RIPPLE_SHOW_REQUEST === "false" ? false : true,
    showEvents: env.RIPPLE_SHOW_EVENTS === "false" ? false : true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--url") {
      options.apiUrl = normalizeApiUrl(nextArg(args, index, arg));
      index += 1;
    } else if (arg === "--api-key") {
      options.apiKey = nextArg(args, index, arg);
      index += 1;
    } else if (arg === "--user-id") {
      options.userId = nextArg(args, index, arg);
      index += 1;
    } else if (arg === "--model") {
      options.model = nextArg(args, index, arg);
      index += 1;
    } else if (arg === "--prompt") {
      options.prompt = nextArg(args, index, arg);
      index += 1;
    } else if (arg === "--session-id") {
      options.sessionId = nextArg(args, index, arg);
      index += 1;
    } else if (arg === "--no-stream") {
      options.stream = false;
    } else if (arg === "--stream") {
      options.stream = true;
    } else if (arg === "--hide-request") {
      options.showRequest = false;
    } else if (arg === "--show-request") {
      options.showRequest = true;
    } else if (arg === "--hide-events") {
      options.showEvents = false;
    } else if (arg === "--show-events") {
      options.showEvents = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function buildClientContextPayload({
  model,
  prompt,
  sessionId,
  stream,
}) {
  return {
    model,
    stream,
    input: [
      {
        role: "user",
        content: prompt,
      },
    ],
    metadata: {
      ripple_session_id: sessionId,
      required_skill_ids: ["ripple:ripple-ui-explainer"],
      client_context: {
        schema_version: "ripple.client_context.v1",
        captured_at: new Date().toISOString(),
        producer: {
          type: "mock_host_app",
          name: "viaim-meeting-demo",
        },
        software: {
          host_app: {
            app_id: "viaim.meeting",
            name: "Viaim Meeting",
            embedding: "ripple_sdk",
          },
          ai_surface: {
            surface_id: "meeting.detail.ai_panel",
            mode: "embedded_panel",
          },
          screen: {
            screen_id: "meeting.detail",
            title: "会议详情",
            layout: "mobile",
          },
          selection: {
            type: "meeting",
            entity_id: "meeting_123",
            display_name: "产品周会",
          },
          entities: [
            {
              type: "meeting",
              id: "meeting_123",
              title: "产品周会",
              state: {
                status: "ended",
                has_transcript: true,
                has_summary: true,
              },
            },
          ],
        },
        devices: [
          {
            id: "headset:primary",
            kind: "ai_headset",
            source: "mock",
            identity: {
              manufacturer: "viaim",
              model: "AI Earbuds",
              firmware_version: "1.2.3",
            },
            connection: {
              state: "connected",
              transport: "bluetooth",
            },
            state: {
              left_battery_percent: 80,
              right_battery_percent: 78,
              case_battery_percent: 55,
              wearing_state: "in_ear",
              noise_control: "anc",
              recording: false,
            },
            capabilities: ["audio_input", "audio_output", "transcription", "noise_control"],
          },
        ],
      },
    },
  };
}

export function redactSecret(value) {
  if (!value) return "(none)";
  if (value.length <= 8) return `${value.slice(0, 2)}...`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function buildTechnicalSummary(options, payload) {
  const authLine = options.apiKey
    ? `Authorization: Bearer ${redactSecret(options.apiKey)}`
    : "Authorization: (not set)";
  return [
    "=== Ripple Client Context Mock Request ===",
    `POST ${options.apiUrl}/responses`,
    "",
    "Headers:",
    "Content-Type: application/json",
    `X-Ripple-User-Id: ${options.userId}`,
    authLine,
    "",
    "Payload:",
    JSON.stringify(payload, null, 2),
    "=== End Request ===",
  ].join("\n");
}

function usage() {
  return `Usage:
  RIPPLE_API_KEY=<key> node scripts/dev/send-client-context-request.mjs [options]

Options:
  --url <url>          Ripple API base URL, default ${DEFAULT_API_URL}
  --api-key <key>      API key, default RIPPLE_API_KEY
  --user-id <id>       X-Ripple-User-Id, default ${DEFAULT_USER_ID}
  --model <model>      Model name, default ${DEFAULT_MODEL}
  --prompt <text>      User prompt for the request
  --session-id <id>    Ripple session id, default generated demo id
  --no-stream          Request non-streaming response
  --stream             Request streaming response
  --hide-request       Do not print request headers and payload
  --hide-events        Do not print SSE event types
`;
}

function eventLogDetail(event) {
  const type = typeof event.type === "string" ? event.type : "";
  if (!/error/i.test(type)) return "";
  const parts = [];
  for (const key of ["message", "error", "detail", "metadata"]) {
    if (event[key] !== undefined) {
      parts.push(`${key}=${JSON.stringify(event[key])}`);
    }
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : ` ${JSON.stringify(event)}`;
}

export function summarizeSseLine(line) {
  if (!line.startsWith("data:")) return null;
  const data = line.slice("data:".length).trim();
  if (!data) return null;
  if (data === "[DONE]") return { done: true, type: "[DONE]", text: "", log: "[sse] [DONE]" };
  try {
    const event = JSON.parse(data);
    const type = typeof event.type === "string" ? event.type : "(unknown)";
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      return { done: false, type, text: event.delta, log: `[sse] ${type}` };
    }
    if (event.type === "error") {
      return {
        done: false,
        type,
        text: `\n[error] ${JSON.stringify(event)}\n`,
        log: `[sse] ${type}${eventLogDetail(event)}`,
      };
    }
    return { done: false, type, text: "", log: `[sse] ${type}${eventLogDetail(event)}` };
  } catch {
    return null;
  }
}

async function printResponse(response, { stream, showEvents }) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  if (!stream) {
    const body = await response.text();
    console.error("\n=== Non-streaming Response ===");
    console.log(body);
    return;
  }

  if (!response.body) {
    throw new Error("Response body is empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const event = summarizeSseLine(line);
      if (!event) continue;
      if (showEvents) {
        console.error(event.log);
      }
      if (event.text) process.stdout.write(event.text);
    }
  }
  process.stdout.write("\n");
}

export async function sendClientContextRequest(options) {
  const payload = buildClientContextPayload(options);
  const headers = {
    "Content-Type": "application/json",
    "X-Ripple-User-Id": options.userId,
  };
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  if (options.showRequest) {
    console.error(buildTechnicalSummary(options, payload));
  } else {
    console.error(`POST ${options.apiUrl}/responses`);
    console.error(`X-Ripple-User-Id: ${options.userId}`);
    console.error(`session_id: ${options.sessionId}`);
  }

  const response = await fetch(`${options.apiUrl}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  await printResponse(response, options);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const options = parseArgs();
    if (options.help) {
      console.log(usage());
    } else {
      await sendClientContextRequest(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
  }
}
