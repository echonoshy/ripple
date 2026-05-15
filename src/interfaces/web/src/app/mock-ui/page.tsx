"use client";

import React, { useState } from "react";
import {
  Bell,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  FileCode2,
  Files,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Inbox,
  LayoutDashboard,
  MessageSquareText,
  MoreHorizontal,
  PanelsTopLeft,
  PlayCircle,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  SplitSquareHorizontal,
  SquareTerminal,
  UserRound,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

type MockVariant = "codex" | "github" | "notion";

const variants: { id: MockVariant; label: string; note: string }[] = [
  { id: "codex", label: "Codex Workbench", note: "任务监督台" },
  { id: "github", label: "GitHub Ops", note: "PR / Checks 密度" },
  { id: "notion", label: "Notion Workspace", note: "空间与文档" },
];

const activeTasks = [
  { title: "Redesign agent workspace", status: "Running", meta: "4 files changed" },
  { title: "Verify sandbox user isolation", status: "Review", meta: "2 approvals pending" },
  { title: "Draft Google connector docs", status: "Queued", meta: "starts after checks" },
];

const timeline = [
  {
    icon: MessageSquareText,
    title: "User request",
    text: "Make Ripple feel like a real tool, not a chat app.",
    time: "09:14",
  },
  {
    icon: Workflow,
    title: "Plan generated",
    text: "Split UI into task page, inspector, workspace nav.",
    time: "09:16",
  },
  { icon: SquareTerminal, title: "Command", text: "bun run build", time: "09:19" },
  {
    icon: GitCommit,
    title: "Change set",
    text: "Updated mock route and interface direction.",
    time: "09:22",
  },
];

const files = [
  { name: "src/app/page.tsx", change: "+184 -32", type: "modified" },
  { name: "src/components/TaskPanel.tsx", change: "+96 -11", type: "modified" },
  { name: "src/components/WorkspaceNav.tsx", change: "+141", type: "added" },
  { name: "docs/ui-direction.md", change: "+68", type: "added" },
];

const checks = [
  { label: "TypeScript", state: "Passed" },
  { label: "ESLint", state: "Passed" },
  { label: "Visual review", state: "Needs review" },
  { label: "Permissions", state: "Waiting" },
];

const commandNavItems: { label: string; icon: LucideIcon; count: string }[] = [
  { label: "Active tasks", icon: LayoutDashboard, count: "3" },
  { label: "Review queue", icon: GitPullRequest, count: "2" },
  { label: "Workspaces", icon: Files, count: "1" },
  { label: "Automations", icon: Zap, count: "6" },
];

const inspectorTabs: { label: string; icon: LucideIcon }[] = [
  { label: "Files", icon: Files },
  { label: "Terminal", icon: SquareTerminal },
  { label: "Diff", icon: SplitSquareHorizontal },
];

const notionNavItems: { label: string; icon: LucideIcon }[] = [
  { label: "Inbox", icon: Inbox },
  { label: "Active work", icon: PlayCircle },
  { label: "Projects", icon: PanelsTopLeft },
  { label: "Knowledge", icon: Files },
  { label: "Automations", icon: Zap },
];

function StatusDot({ tone = "blue" }: { tone?: "blue" | "green" | "yellow" | "red" | "gray" }) {
  const colors = {
    blue: "bg-[#0969da]",
    green: "bg-[#1a7f37]",
    yellow: "bg-[#bf8700]",
    red: "bg-[#cf222e]",
    gray: "bg-[#6e7781]",
  };
  return <span className={`h-2 w-2 rounded-full ${colors[tone]}`} />;
}

function Pill({
  children,
  tone = "gray",
}: {
  children: React.ReactNode;
  tone?: "blue" | "green" | "yellow" | "red" | "gray";
}) {
  const tones = {
    blue: "border-[#0969da]/25 bg-[#ddf4ff] text-[#0969da]",
    green: "border-[#1a7f37]/25 bg-[#dafbe1] text-[#1a7f37]",
    yellow: "border-[#bf8700]/25 bg-[#fff8c5] text-[#7d4e00]",
    red: "border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e]",
    gray: "border-[#d0d7de] bg-[#f6f8fa] text-[#57606a]",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function IconButton({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#d0d7de] bg-white text-[#57606a] transition-colors hover:bg-[#f6f8fa] hover:text-[#24292f]"
    >
      {children}
    </button>
  );
}

function VariantSwitcher({
  selected,
  onSelect,
}: {
  selected: MockVariant;
  onSelect: (variant: MockVariant) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[#d0d7de] bg-white px-4 py-3">
      <div className="mr-2 flex items-center gap-2 text-sm font-semibold text-[#24292f]">
        <Sparkles size={16} className="text-[#0969da]" />
        Mock UI versions
      </div>
      {variants.map((variant) => (
        <button
          key={variant.id}
          type="button"
          onClick={() => onSelect(variant.id)}
          className={`rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
            selected === variant.id
              ? "border-[#0969da] bg-[#ddf4ff] text-[#0969da]"
              : "border-[#d0d7de] bg-white text-[#57606a] hover:bg-[#f6f8fa]"
          }`}
        >
          <span className="block leading-tight font-semibold">{variant.label}</span>
          <span className="block text-xs opacity-75">{variant.note}</span>
        </button>
      ))}
    </div>
  );
}

function TopBar({ title, calm = false }: { title: string; calm?: boolean }) {
  return (
    <header
      className={`flex h-14 shrink-0 items-center justify-between border-b px-4 ${
        calm ? "border-[#ebe8e2] bg-[#fbfaf8]" : "border-[#d0d7de] bg-[#f6f8fa]"
      }`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md border border-[#d0d7de] bg-white text-[#0969da]">
          <Bot size={17} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[#24292f]">{title}</div>
          <div className="truncate text-xs text-[#57606a]">echonoshy/ripple · lake/default</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Pill tone="green">
          <StatusDot tone="green" />
          Online
        </Pill>
        <IconButton label="Notifications">
          <Bell size={15} />
        </IconButton>
        <IconButton label="Settings">
          <Settings size={15} />
        </IconButton>
      </div>
    </header>
  );
}

function CodexWorkbenchMock() {
  return (
    <div className="flex min-h-0 flex-1 bg-white">
      <aside className="hidden w-72 shrink-0 border-r border-[#d0d7de] bg-[#f6f8fa] lg:flex lg:flex-col">
        <div className="border-b border-[#d0d7de] p-3">
          <button className="flex w-full items-center gap-2 rounded-md border border-[#d0d7de] bg-white px-3 py-2 text-left text-sm text-[#57606a]">
            <Search size={15} />
            Search tasks, files, skills
          </button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-5">
            <div className="mb-2 px-2 text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
              Command center
            </div>
            {commandNavItems.map((item, index) => (
              <button
                key={item.label}
                className={`mb-1 flex w-full items-center justify-between rounded-md px-2 py-2 text-sm ${
                  index === 0
                    ? "bg-[#eaeef2] font-semibold text-[#24292f]"
                    : "text-[#57606a] hover:bg-[#eaeef2]"
                }`}
              >
                <span className="flex items-center gap-2">
                  <item.icon size={15} />
                  {item.label}
                </span>
                <span className="text-xs text-[#6e7781]">{item.count}</span>
              </button>
            ))}
          </div>
          <div>
            <div className="mb-2 px-2 text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
              Running now
            </div>
            <div className="space-y-2">
              {activeTasks.map((task, index) => (
                <button
                  key={task.title}
                  className={`w-full rounded-md border p-3 text-left ${
                    index === 0
                      ? "border-[#0969da] bg-white"
                      : "border-[#d0d7de] bg-white hover:bg-[#f6f8fa]"
                  }`}
                >
                  <div className="mb-1 flex items-center gap-2 text-sm font-medium text-[#24292f]">
                    <StatusDot tone={index === 0 ? "blue" : index === 1 ? "yellow" : "gray"} />
                    <span className="truncate">{task.title}</span>
                  </div>
                  <div className="text-xs text-[#57606a]">
                    {task.status} · {task.meta}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar title="Redesign agent workspace" />
        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="border-b border-[#d0d7de] bg-white px-6 py-5">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Pill tone="blue">Running</Pill>
                <Pill tone="gray">
                  <GitBranch size={12} />
                  codex/ui-workbench
                </Pill>
                <Pill tone="green">
                  <ShieldCheck size={12} />
                  sandbox ready
                </Pill>
              </div>
              <h1 className="text-xl font-semibold tracking-normal text-[#24292f]">
                Turn Ripple into an agent workbench UI
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-[#57606a]">
                Reduce chat dominance, surface task state, workspace files, terminal output,
                approvals, and reviewable changes.
              </p>
            </div>
            <div className="flex gap-1 border-b border-[#d0d7de] px-6">
              {["Overview", "Timeline", "Changes", "Notes"].map((tab, index) => (
                <button
                  key={tab}
                  className={`border-b-2 px-3 py-3 text-sm font-medium ${
                    index === 0
                      ? "border-[#fd8c73] text-[#24292f]"
                      : "border-transparent text-[#57606a] hover:text-[#24292f]"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="mb-5 grid gap-3 md:grid-cols-3">
                {[
                  ["Plan", "4 steps", "Current step: visual mock variants"],
                  ["Context", "186K tokens", "AGENTS.md, web app, UI notes"],
                  ["Output", "3 drafts", "Workbench, GitHub Ops, Notion Workspace"],
                ].map(([label, value, detail]) => (
                  <div key={label} className="rounded-lg border border-[#d0d7de] bg-[#f6f8fa] p-4">
                    <div className="text-xs font-medium tracking-wide text-[#6e7781] uppercase">
                      {label}
                    </div>
                    <div className="mt-1 text-lg font-semibold text-[#24292f]">{value}</div>
                    <div className="mt-1 text-xs text-[#57606a]">{detail}</div>
                  </div>
                ))}
              </div>
              <div className="space-y-3">
                {timeline.map((item) => (
                  <div
                    key={item.title}
                    className="flex gap-3 rounded-lg border border-[#d0d7de] bg-white p-4"
                  >
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#f6f8fa] text-[#57606a]">
                      <item.icon size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium text-[#24292f]">{item.title}</div>
                        <div className="text-xs text-[#6e7781]">{item.time}</div>
                      </div>
                      <div className="mt-1 text-sm text-[#57606a]">{item.text}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="border-t border-[#d0d7de] bg-white p-4">
              <div className="flex items-end gap-2 rounded-lg border border-[#d0d7de] bg-[#f6f8fa] p-2">
                <textarea
                  rows={2}
                  placeholder="Ask, redirect, approve, or add context..."
                  className="min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-[#24292f] outline-none placeholder:text-[#6e7781]"
                />
                <button className="rounded-md bg-[#1f883d] px-3 py-2 text-sm font-semibold text-white">
                  Send
                </button>
              </div>
            </div>
          </section>
          <Inspector compact={false} />
        </div>
      </main>
    </div>
  );
}

function Inspector({ compact }: { compact: boolean }) {
  return (
    <aside
      className={`${compact ? "hidden xl:flex" : "hidden 2xl:flex"} w-[360px] shrink-0 flex-col border-l border-[#d0d7de] bg-[#f6f8fa]`}
    >
      <div className="flex gap-1 border-b border-[#d0d7de] bg-white p-2">
        {inspectorTabs.map((tab, index) => (
          <button
            key={tab.label}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium ${
              index === 0 ? "bg-[#eaeef2] text-[#24292f]" : "text-[#57606a] hover:bg-[#f6f8fa]"
            }`}
          >
            <tab.icon size={13} />
            {tab.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-5">
          <div className="mb-2 text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
            Changed files
          </div>
          <div className="overflow-hidden rounded-lg border border-[#d0d7de] bg-white">
            {files.map((file) => (
              <div
                key={file.name}
                className="flex items-center gap-2 border-b border-[#d8dee4] px-3 py-2 last:border-b-0"
              >
                <FileCode2
                  size={14}
                  className={file.type === "added" ? "text-[#1a7f37]" : "text-[#0969da]"}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-[#24292f]">
                  {file.name}
                </span>
                <span className="text-xs text-[#57606a]">{file.change}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="mb-5">
          <div className="mb-2 text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
            Checks
          </div>
          <div className="space-y-2">
            {checks.map((check, index) => (
              <div
                key={check.label}
                className="flex items-center justify-between rounded-lg border border-[#d0d7de] bg-white px-3 py-2"
              >
                <span className="flex items-center gap-2 text-sm text-[#24292f]">
                  {index < 2 ? (
                    <CheckCircle2 size={15} className="text-[#1a7f37]" />
                  ) : (
                    <Circle size={15} className="text-[#bf8700]" />
                  )}
                  {check.label}
                </span>
                <span className="text-xs text-[#57606a]">{check.state}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
            Terminal preview
          </div>
          <pre className="overflow-auto rounded-lg bg-[#0d1117] p-4 font-mono text-xs leading-6 text-[#c9d1d9]">
            {`$ bun run build
✓ Compiled successfully
✓ Linting and checking types

$ uv run pytest tests/web
17 passed in 1.28s`}
          </pre>
        </div>
      </div>
    </aside>
  );
}

function GitHubOpsMock() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#f6f8fa]">
      <TopBar title="Pull request style review queue" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-5 py-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-[#24292f]">
                Redesign web UI into task-oriented workbench{" "}
                <span className="text-[#6e7781]">#48</span>
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[#57606a]">
                <Pill tone="green">Open</Pill>
                <span>ripple-agent wants to merge 3 commits into</span>
                <Pill>master</Pill>
                <span>from</span>
                <Pill>codex/workbench-ui</Pill>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button className="rounded-md border border-[#d0d7de] bg-white px-3 py-1.5 text-sm font-medium text-[#24292f]">
                Edit
              </button>
              <button className="rounded-md bg-[#1f883d] px-3 py-1.5 text-sm font-semibold text-white">
                Approve
              </button>
            </div>
          </div>
          <div className="mb-4 flex gap-1 border-b border-[#d0d7de]">
            {[
              ["Conversation", "8"],
              ["Commits", "3"],
              ["Checks", "4"],
              ["Files changed", "4"],
            ].map(([label, count], index) => (
              <button
                key={label}
                className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium ${
                  index === 0
                    ? "border-[#fd8c73] text-[#24292f]"
                    : "border-transparent text-[#57606a] hover:text-[#24292f]"
                }`}
              >
                {label}
                <span className="rounded-full bg-[#eaeef2] px-1.5 py-0.5 text-xs">{count}</span>
              </button>
            ))}
          </div>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="space-y-4">
              <div className="overflow-hidden rounded-lg border border-[#d0d7de] bg-white">
                <div className="border-b border-[#d0d7de] bg-[#f6f8fa] px-4 py-3 text-sm font-semibold text-[#24292f]">
                  Agent summary
                </div>
                <div className="space-y-3 p-4 text-sm leading-6 text-[#24292f]">
                  <p>
                    Converted the chat-first page into a reviewable task interface with persistent
                    context panels.
                  </p>
                  <ul className="list-disc space-y-1 pl-5 text-[#57606a]">
                    <li>
                      Left navigation groups tasks, projects, automations, and recent sessions.
                    </li>
                    <li>
                      Main area reads like a PR conversation with explicit checks and file changes.
                    </li>
                    <li>
                      Right rail carries metadata, approvals, model choice, and sandbox state.
                    </li>
                  </ul>
                </div>
              </div>
              <div className="overflow-hidden rounded-lg border border-[#d0d7de] bg-white">
                <div className="grid grid-cols-[1fr_120px_100px] border-b border-[#d0d7de] bg-[#f6f8fa] px-4 py-2 text-xs font-semibold tracking-wide text-[#6e7781] uppercase">
                  <span>Check</span>
                  <span>Status</span>
                  <span>Duration</span>
                </div>
                {checks.map((check, index) => (
                  <div
                    key={check.label}
                    className="grid grid-cols-[1fr_120px_100px] items-center border-b border-[#d8dee4] px-4 py-3 text-sm last:border-b-0"
                  >
                    <span className="flex items-center gap-2 font-medium text-[#24292f]">
                      {index < 2 ? (
                        <CheckCircle2 size={16} className="text-[#1a7f37]" />
                      ) : (
                        <Clock3 size={16} className="text-[#bf8700]" />
                      )}
                      {check.label}
                    </span>
                    <span className="text-[#57606a]">{check.state}</span>
                    <span className="font-mono text-xs text-[#6e7781]">
                      {index + 1}m {index * 7 + 8}s
                    </span>
                  </div>
                ))}
              </div>
              <div className="overflow-hidden rounded-lg border border-[#d0d7de] bg-white">
                <div className="border-b border-[#d0d7de] bg-[#f6f8fa] px-4 py-3 text-sm font-semibold text-[#24292f]">
                  File changes
                </div>
                {files.map((file) => (
                  <div
                    key={file.name}
                    className="flex items-center gap-3 border-b border-[#d8dee4] px-4 py-3 last:border-b-0"
                  >
                    <FileCode2
                      size={16}
                      className={file.type === "added" ? "text-[#1a7f37]" : "text-[#0969da]"}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-[#24292f]">
                      {file.name}
                    </span>
                    <span className="font-mono text-xs text-[#57606a]">{file.change}</span>
                    <MoreHorizontal size={16} className="text-[#6e7781]" />
                  </div>
                ))}
              </div>
            </section>
            <aside className="space-y-4">
              <div className="rounded-lg border border-[#d0d7de] bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-[#24292f]">Reviewers</div>
                <div className="space-y-2">
                  {["lake", "product", "security"].map((name, index) => (
                    <div key={name} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 text-[#24292f]">
                        <UserRound size={16} />
                        {name}
                      </span>
                      <span className="text-xs text-[#57606a]">
                        {index === 0 ? "Required" : "Optional"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-[#d0d7de] bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-[#24292f]">Agent metadata</div>
                <div className="space-y-2 text-sm text-[#57606a]">
                  <div className="flex justify-between">
                    <span>Model</span>
                    <span className="font-mono">codex-medium</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Sandbox</span>
                    <span>ready</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Context</span>
                    <span>186K</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Risk</span>
                    <span>normal</span>
                  </div>
                </div>
              </div>
              <div className="rounded-lg border border-[#d0d7de] bg-white p-4">
                <button className="w-full rounded-md bg-[#1f883d] px-3 py-2 text-sm font-semibold text-white">
                  Merge when checks pass
                </button>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

function NotionWorkspaceMock() {
  return (
    <div className="flex min-h-0 flex-1 bg-[#fbfaf8] text-[#37352f]">
      <aside className="hidden w-72 shrink-0 border-r border-[#ebe8e2] bg-[#f7f6f3] lg:flex lg:flex-col">
        <div className="flex items-center justify-between border-b border-[#ebe8e2] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#ece9e3]">
              <Bot size={15} />
            </div>
            <span className="truncate text-sm font-semibold">Ripple Workspace</span>
          </div>
          <ChevronDown size={15} className="text-[#787774]" />
        </div>
        <div className="p-3">
          <button className="mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[#787774] hover:bg-[#efeeea]">
            <Search size={15} />
            Search
          </button>
          {notionNavItems.map((item, index) => (
            <button
              key={item.label}
              className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                index === 1
                  ? "bg-[#efeeea] font-medium text-[#37352f]"
                  : "text-[#5f5e5b] hover:bg-[#efeeea]"
              }`}
            >
              <item.icon size={15} />
              {item.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <div className="mt-3 px-2 text-xs font-medium tracking-wide text-[#9b9a97] uppercase">
            Projects
          </div>
          {["ripple", "connector auth", "agent memory", "web polish"].map((project, index) => (
            <button
              key={project}
              className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[#5f5e5b] hover:bg-[#efeeea]"
            >
              <span className="text-base">{index === 0 ? "◼" : "□"}</span>
              {project}
            </button>
          ))}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar title="Active work / Ripple UI direction" calm />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-6 py-8">
            <div className="mb-5 text-5xl">⌘</div>
            <h1 className="mb-3 text-3xl font-semibold tracking-normal text-[#37352f]">
              Ripple UI direction
            </h1>
            <p className="max-w-3xl text-base leading-7 text-[#5f5e5b]">
              A calm workspace for agent tasks, project context, files, approvals, and review notes.
              Chat is present, but the page is organized around work.
            </p>
            <div className="my-6 h-px bg-[#ebe8e2]" />
            <div className="grid gap-4 md:grid-cols-3">
              {[
                ["Current focus", "Workbench mockups", "3 visual directions"],
                ["Status", "Design review", "Waiting on product choice"],
                ["Next", "Pick layout system", "Then wire real data"],
              ].map(([label, value, detail]) => (
                <div key={label} className="rounded-md border border-[#ebe8e2] bg-white p-4">
                  <div className="text-xs font-medium tracking-wide text-[#9b9a97] uppercase">
                    {label}
                  </div>
                  <div className="mt-2 text-lg font-semibold">{value}</div>
                  <div className="mt-1 text-sm text-[#787774]">{detail}</div>
                </div>
              ))}
            </div>
            <section className="mt-7">
              <h2 className="mb-3 text-lg font-semibold">Task board</h2>
              <div className="overflow-hidden rounded-md border border-[#ebe8e2] bg-white">
                <div className="grid grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr] border-b border-[#ebe8e2] bg-[#fbfaf8] px-3 py-2 text-xs font-medium tracking-wide text-[#9b9a97] uppercase">
                  <span>Name</span>
                  <span>Status</span>
                  <span>Owner</span>
                  <span>Updated</span>
                </div>
                {activeTasks.map((task, index) => (
                  <div
                    key={task.title}
                    className="grid grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr] items-center border-b border-[#ebe8e2] px-3 py-3 text-sm last:border-b-0"
                  >
                    <span className="min-w-0 truncate font-medium">{task.title}</span>
                    <span>
                      <Pill tone={index === 0 ? "blue" : index === 1 ? "yellow" : "gray"}>
                        {task.status}
                      </Pill>
                    </span>
                    <span className="text-[#787774]">Codex</span>
                    <span className="text-[#787774]">{index + 4}m ago</span>
                  </div>
                ))}
              </div>
            </section>
            <section className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
              <div>
                <h2 className="mb-3 text-lg font-semibold">Working notes</h2>
                <div className="rounded-md border border-[#ebe8e2] bg-white p-4 text-sm leading-7 text-[#5f5e5b]">
                  <p>
                    This direction works when Ripple wants to feel like a persistent workspace:
                    notes, task database, files, and agent output live together.
                  </p>
                  <p className="mt-3">
                    It is less dense than GitHub and more readable than a terminal-first interface,
                    but may need extra affordances for code review and approval-heavy flows.
                  </p>
                </div>
              </div>
              <div>
                <h2 className="mb-3 text-lg font-semibold">Context</h2>
                <div className="space-y-2 rounded-md border border-[#ebe8e2] bg-white p-3">
                  {["AGENTS.md", "Workspace files", "Recent sessions", "Connected apps"].map(
                    (item) => (
                      <div
                        key={item}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[#5f5e5b] hover:bg-[#f7f6f3]"
                      >
                        <FileCode2 size={15} />
                        {item}
                      </div>
                    )
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function MockUiPage() {
  const [selected, setSelected] = useState<MockVariant>("codex");

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-white font-[family-name:var(--font-sans)]">
      <VariantSwitcher selected={selected} onSelect={setSelected} />
      {selected === "codex" && <CodexWorkbenchMock />}
      {selected === "github" && <GitHubOpsMock />}
      {selected === "notion" && <NotionWorkspaceMock />}
    </div>
  );
}
