import React, { useMemo, useState } from "react";
import {
  Battery,
  BluetoothConnected,
  BrainCircuit,
  CheckCircle2,
  Loader2,
  MicOff,
  Radio,
  Send,
} from "lucide-react";
import {
  AuthError,
  getApiKey,
  getConfiguredApiUrl,
  getUserId,
  sendChatMessage,
  setApiKey,
  setUserId,
  type ChatClientContext,
  type ChatStreamCallbacks,
} from "@/lib/api";
import { buildViaimMeetingDemoClientContext } from "@/lib/clientContext";

const DEMO_SKILL_ID = "ripple:viaim-product-support";
const DEFAULT_MODEL = "codex-high";
const DEFAULT_PROMPT = "现在耳机电量是多少？";

function textValue(value: unknown, fallback = "-"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function batteryLabel(label: string, value: unknown): string {
  const percent = numberValue(value);
  return `${label} ${percent === null ? "-" : `${percent}%`}`;
}

function firstDevice(context: ChatClientContext) {
  return context.devices?.[0] || {};
}

function formatConnectionState(value: unknown): string {
  return value === "connected" ? "已连接" : textValue(value, "未知");
}

function formatNoiseControl(value: unknown): string {
  return value === "anc" ? "主动降噪" : textValue(value, "未知");
}

function formatRecording(value: unknown): string {
  return value === false ? "未录音" : value === true ? "录音中" : "未知";
}

function statusPillClass(tone: "green" | "blue" | "amber") {
  if (tone === "green") return "border-[#8DE0B5] bg-[#EFFAF5] text-[#16845B]";
  if (tone === "amber") return "border-[#FAD355] bg-[#FFF8DB] text-[#8B5E00]";
  return "border-[#BACEFD] bg-[#F0F5FF] text-[#1456F0]";
}

export default function ClientContextDemoPage() {
  const context = useMemo(() => buildViaimMeetingDemoClientContext(), []);
  const device = firstDevice(context);
  const deviceState = device.state || {};
  const [apiKeyInput, setApiKeyInput] = useState(() => getApiKey() || "");
  const [userIdInput, setUserIdInput] = useState(() => getUserId());
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "completed" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [credentialMessage, setCredentialMessage] = useState<string | null>(null);

  const saveCredentials = () => {
    setCredentialMessage(null);
    const nextUserId = userIdInput.trim();
    if (!nextUserId) {
      setCredentialMessage("请填写 user id");
      return false;
    }
    try {
      setUserId(nextUserId);
      if (apiKeyInput.trim()) setApiKey(apiKeyInput.trim());
      setCredentialMessage("已保存到本机浏览器");
      return true;
    } catch (credentialError) {
      setCredentialMessage(
        credentialError instanceof Error ? credentialError.message : String(credentialError)
      );
      return false;
    }
  };

  const sendDemoQuestion = async () => {
    if (!saveCredentials()) return;
    if (!apiKeyInput.trim()) {
      setError("请先填写服务 API key。");
      setStatus("error");
      return;
    }

    const question = prompt.trim() || DEFAULT_PROMPT;
    const sessionId = `client-context-demo-web-${Date.now()}`;
    let nextAnswer = "";
    setAnswer("");
    setError(null);
    setStatus("running");

    const callbacks: ChatStreamCallbacks = {
      onMessageDelta: (delta) => {
        nextAnswer += delta;
        setAnswer(nextAnswer);
      },
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onUsage: () => undefined,
      onComplete: () => {
        setStatus("completed");
      },
      onError: (streamError) => {
        setStatus("error");
        setError(
          streamError instanceof AuthError
            ? "API key 无效或已过期，请检查后重试。"
            : streamError.message
        );
      },
    };

    await sendChatMessage(sessionId, question, model.trim() || DEFAULT_MODEL, callbacks, {
      requiredSkillIds: [DEMO_SKILL_ID],
      clientContext: context,
    });
  };

  const appName = textValue(context.software?.host_app?.name);
  const screenTitle = textValue(context.software?.screen?.title);
  const selectionName = textValue(context.software?.selection?.display_name);
  const source = textValue(device.source);

  return (
    <main
      data-ripple-client-context-demo-page="true"
      className="min-h-dvh bg-[#F8FAFC] text-[#1F2329]"
    >
      <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-[#DEE0E3] pb-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-[#BACEFD] bg-[#F0F5FF] px-3 py-1 text-[12px] leading-5 font-medium text-[#1456F0]">
              <BrainCircuit size={14} />
              Client Context Demo
            </div>
            <h1 className="text-[28px] leading-9 font-semibold text-[#1F2329] sm:text-[34px] sm:leading-10">
              可见的 Viaim 当前上下文
            </h1>
            <p className="mt-2 max-w-2xl text-[14px] leading-6 text-[#646A73]">
              这个页面独立于 Ripple 聊天界面，用同一份结构化 context 展示当前页面、会议选择和 mock
              耳机状态。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span
              className={`rounded-full border px-3 py-1 text-[12px] ${statusPillClass("blue")}`}
            >
              schema: ripple.client_context.v1
            </span>
            <span
              className={`rounded-full border px-3 py-1 text-[12px] ${statusPillClass("amber")}`}
            >
              Mock 数据
            </span>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-lg border border-[#DEE0E3] bg-white p-4 shadow-[0_1px_2px_rgba(31,35,41,0.04)]">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[16px] leading-6 font-semibold">Host App</h2>
                <p className="text-[13px] leading-5 text-[#646A73]">{appName}</p>
              </div>
              <span className="rounded-full border border-[#DEE0E3] bg-[#F8F9FA] px-2.5 py-1 text-[12px] text-[#646A73]">
                {textValue(context.software?.screen?.layout)}
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border border-[#EFF0F1] bg-[#FBFCFD] p-3">
                <div className="text-[12px] leading-5 text-[#646A73]">当前页面</div>
                <div className="mt-1 text-[18px] leading-7 font-semibold">{screenTitle}</div>
              </div>
              <div className="rounded-md border border-[#EFF0F1] bg-[#FBFCFD] p-3">
                <div className="text-[12px] leading-5 text-[#646A73]">当前对象</div>
                <div className="mt-1 text-[18px] leading-7 font-semibold">{selectionName}</div>
              </div>
              <div className="rounded-md border border-[#EFF0F1] bg-[#FBFCFD] p-3">
                <div className="text-[12px] leading-5 text-[#646A73]">状态来源</div>
                <div className="mt-1 text-[18px] leading-7 font-semibold">
                  {source === "mock" ? "Mock 数据" : source}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-[#DEE0E3] bg-white p-4 shadow-[0_1px_2px_rgba(31,35,41,0.04)]">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-[16px] leading-6 font-semibold">AI Earbuds</h2>
                <p className="text-[13px] leading-5 text-[#646A73]">
                  {formatConnectionState(device.connection?.state)}
                </p>
              </div>
              <BluetoothConnected size={20} className="text-[#1456F0]" />
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between rounded-md border border-[#EFF0F1] px-3 py-2">
                <span className="inline-flex items-center gap-2 text-[13px] text-[#646A73]">
                  <Battery size={15} />
                  电量
                </span>
                <span className="text-[13px] font-medium">
                  {batteryLabel("左耳", deviceState.left_battery_percent)} /{" "}
                  {batteryLabel("右耳", deviceState.right_battery_percent)}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-[#EFF0F1] px-3 py-2">
                <span className="text-[13px] text-[#646A73]">充电盒</span>
                <span className="text-[13px] font-medium">
                  {batteryLabel("充电盒", deviceState.case_battery_percent)}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-[#EFF0F1] px-3 py-2">
                <span className="inline-flex items-center gap-2 text-[13px] text-[#646A73]">
                  <Radio size={15} />
                  降噪
                </span>
                <span className="text-[13px] font-medium">
                  {formatNoiseControl(deviceState.noise_control)}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-[#EFF0F1] px-3 py-2">
                <span className="inline-flex items-center gap-2 text-[13px] text-[#646A73]">
                  <MicOff size={15} />
                  录音
                </span>
                <span className="text-[13px] font-medium">
                  {formatRecording(deviceState.recording)}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="grid min-h-0 gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <form
            className="rounded-lg border border-[#DEE0E3] bg-white p-4 shadow-[0_1px_2px_rgba(31,35,41,0.04)]"
            onSubmit={(event) => {
              event.preventDefault();
              void sendDemoQuestion();
            }}
          >
            <h2 className="text-[16px] leading-6 font-semibold">演示请求</h2>
            <p className="mt-1 text-[13px] leading-5 text-[#646A73]">
              点击发送会把上方可见的 context 一起传入 `/v1/responses`。
            </p>

            <label className="mt-4 block text-[13px] font-medium text-[#2B2F36]">
              API key
              <input
                value={apiKeyInput}
                onChange={(event) => setApiKeyInput(event.target.value)}
                type="password"
                autoComplete="off"
                className="mt-1 h-10 w-full rounded-md border border-[#DEE0E3] bg-white px-3 text-[14px] outline-none focus:border-[#1456F0] focus:ring-2 focus:ring-[#BACEFD]"
                placeholder="rk-ripple-..."
              />
            </label>

            <label className="mt-3 block text-[13px] font-medium text-[#2B2F36]">
              User ID
              <input
                value={userIdInput}
                onChange={(event) => setUserIdInput(event.target.value)}
                className="mt-1 h-10 w-full rounded-md border border-[#DEE0E3] bg-white px-3 text-[14px] outline-none focus:border-[#1456F0] focus:ring-2 focus:ring-[#BACEFD]"
              />
            </label>

            <label className="mt-3 block text-[13px] font-medium text-[#2B2F36]">
              Model
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="mt-1 h-10 w-full rounded-md border border-[#DEE0E3] bg-white px-3 text-[14px] outline-none focus:border-[#1456F0] focus:ring-2 focus:ring-[#BACEFD]"
              />
            </label>

            <label className="mt-3 block text-[13px] font-medium text-[#2B2F36]">
              问题
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={3}
                className="mt-1 w-full resize-none rounded-md border border-[#DEE0E3] bg-white px-3 py-2 text-[14px] leading-6 outline-none focus:border-[#1456F0] focus:ring-2 focus:ring-[#BACEFD]"
              />
            </label>

            {credentialMessage && (
              <div className="mt-3 text-[12px] leading-5 text-[#646A73]">{credentialMessage}</div>
            )}
            {error && <div className="mt-3 text-[12px] leading-5 text-[#B42318]">{error}</div>}

            <button
              type="submit"
              disabled={status === "running"}
              className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#1456F0] px-4 text-[14px] font-medium text-white transition-colors hover:bg-[#0F4BD8] active:bg-[#0B3FB8] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {status === "running" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Send size={16} />
              )}
              发送演示问题
            </button>

            <div className="mt-4 rounded-md border border-[#EFF0F1] bg-[#FBFCFD] p-3 text-[12px] leading-5 text-[#646A73]">
              API: {getConfiguredApiUrl()}
            </div>
          </form>

          <div className="rounded-lg border border-[#DEE0E3] bg-white p-4 shadow-[0_1px_2px_rgba(31,35,41,0.04)]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[16px] leading-6 font-semibold">AI 回答</h2>
                <p className="text-[13px] leading-5 text-[#646A73]">
                  这里显示独立演示请求的流式返回。
                </p>
              </div>
              {status === "completed" && <CheckCircle2 size={20} className="text-[#16845B]" />}
            </div>
            <div className="min-h-[220px] rounded-md border border-[#EFF0F1] bg-[#FBFCFD] p-4 text-[14px] leading-7 whitespace-pre-wrap text-[#2B2F36]">
              {answer ||
                (status === "running"
                  ? "正在等待模型回答..."
                  : "先确认左侧 API key，然后点击发送演示问题。")}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
