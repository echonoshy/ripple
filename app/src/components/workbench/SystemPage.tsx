"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDrive,
  Loader2,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import {
  AuthError,
  fetchDoctorReport,
  fetchReadyHealth,
  fetchSandboxRuntimeInfo,
  fetchUserProfile,
  getConfiguredApiUrl,
} from "@/lib/api";
import type {
  DoctorReport,
  HealthCheck,
  ReadyHealth,
  RuntimeSandboxInfo,
  UserProfile,
} from "@/types";

interface SystemPageProps {
  userId: string;
  onAuthExpired: (message: string) => void;
}

function statusTone(status: string): string {
  if (status === "pass" || status === "ready")
    return "border-[#1a7f37]/25 bg-[#dafbe1] text-[#1a7f37]";
  if (status === "warn" || status === "degraded")
    return "border-[#bf8700]/25 bg-[#fff8c5] text-[#7d4e00]";
  return "border-[#cf222e]/25 bg-[#ffebe9] text-[#cf222e]";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function SystemPage({ userId, onAuthExpired }: SystemPageProps) {
  const [ready, setReady] = useState<ReadyHealth | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [sandbox, setSandbox] = useState<RuntimeSandboxInfo | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [readyData, doctorData, sandboxData, profileData] = await Promise.all([
        fetchReadyHealth(),
        fetchDoctorReport(),
        fetchSandboxRuntimeInfo(),
        fetchUserProfile(),
      ]);
      setReady(readyData);
      setDoctor(doctorData);
      setSandbox(sandboxData);
      setProfile(profileData);
    } catch (err) {
      if (err instanceof AuthError) {
        onAuthExpired("API key 已失效");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load system status");
    } finally {
      setIsLoading(false);
    }
  }, [onAuthExpired]);

  useEffect(() => {
    void load();
  }, [load, userId]);

  const readyChecks = useMemo(() => Object.values(ready?.checks || {}), [ready?.checks]);
  const maxWorkspaceBytes = profile?.limits?.max_workspace_bytes || 0;
  const workspaceBytes = profile?.usage?.workspace_size_bytes || 0;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_16%_0%,rgba(47,107,255,0.12),transparent_34%),radial-gradient(circle_at_88%_8%,rgba(139,92,246,0.11),transparent_32%),#fbfdff] px-4 pt-[max(env(safe-area-inset-top),16px)] pb-[calc(88px+env(safe-area-inset-bottom))] text-[#111827] md:px-8 lg:pb-5">
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3 pb-1">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-[20px] leading-7 font-semibold tracking-normal">
              <ServerCog size={20} />
              System
            </h1>
            <div className="mt-1 font-[family-name:var(--font-mono)] text-[11px] text-[#7a8496]">
              {getConfiguredApiUrl()}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={isLoading}
            aria-label="Refresh system status"
            title="Refresh system status"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#dfe6f4] bg-white/78 text-[#384152] shadow-[0_10px_24px_rgba(44,63,123,0.06)] hover:bg-white disabled:opacity-60"
          >
            {isLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          </button>
        </header>

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-[#cf222e]/25 bg-[#ffebe9] px-3 py-3 text-sm font-medium text-[#cf222e]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : null}

        <section className="grid gap-3 md:grid-cols-4">
          <StatusMetric
            icon={<ShieldCheck size={16} />}
            label="Ready"
            value={ready?.status || "loading"}
          />
          <StatusMetric
            icon={<ServerCog size={16} />}
            label="Mode"
            value={doctor?.deployment_mode || sandbox?.deployment_mode || "trusted-proxy"}
          />
          <StatusMetric
            icon={<Database size={16} />}
            label="SQLite"
            value={ready?.checks?.sqlite?.status || "unknown"}
          />
          <StatusMetric
            icon={<HardDrive size={16} />}
            label="Workspace"
            value={
              maxWorkspaceBytes
                ? `${formatBytes(workspaceBytes)} / ${formatBytes(maxWorkspaceBytes)}`
                : formatBytes(workspaceBytes)
            }
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="overflow-hidden rounded-2xl border border-[#dfe6f4] bg-white/74 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl">
            <div className="border-b border-[#e8edf7] px-4 py-3 text-[13px] font-semibold">
              Doctor checks
            </div>
            <div className="divide-y divide-[#e8edf7]">
              {(doctor?.checks || readyChecks).map((check) => (
                <CheckRow key={check.name} check={check} />
              ))}
              {!doctor && !readyChecks.length && (
                <div className="flex h-28 items-center justify-center text-[13px] text-[#667085]">
                  {isLoading ? "Loading checks" : "No checks"}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <InfoPanel
              icon={<TerminalSquare size={16} />}
              title="Runtime boundary"
              rows={[
                ["Codex", sandbox?.execution?.codex?.runtime_boundary || "managed_permissions"],
                ["Connectors", sandbox?.execution?.connectors?.runtime_boundary || "nsjail"],
                ["Workspace", sandbox?.execution?.workspace?.isolation_unit || "user_id"],
              ]}
            />
            <InfoPanel
              icon={<Database size={16} />}
              title="Backup contract"
              rows={[
                [
                  "Include",
                  (doctor?.backup_contract?.include || []).join(", ") ||
                    ".ripple/ripple.sqlite, workspaces, credentials",
                ],
                [
                  "Exclude",
                  (doctor?.backup_contract?.exclude || []).join(", ") || ".ripple/sandboxes-cache",
                ],
                [
                  "Codex auth",
                  doctor?.backup_contract?.codex_auth ||
                    "Re-login service CODEX_HOME after restore",
                ],
              ]}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function StatusMetric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-[#dfe6f4] bg-white/74 p-3 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl">
      <div className="flex items-center gap-2 text-[11px] font-semibold text-[#667085]">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 truncate font-[family-name:var(--font-mono)] text-[13px] font-semibold text-[#111827]">
        {value}
      </div>
    </div>
  );
}

function CheckRow({ check }: { check: HealthCheck }) {
  return (
    <div className="grid gap-2 px-4 py-3 md:grid-cols-[140px_90px_minmax(0,1fr)] md:items-center">
      <div className="truncate font-[family-name:var(--font-mono)] text-[12px] font-semibold">
        {check.name}
      </div>
      <span
        className={`inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusTone(check.status)}`}
      >
        <CheckCircle2 size={12} />
        {check.status}
      </span>
      <div className="min-w-0 text-[12px] leading-5 text-[#667085]">{check.message}</div>
    </div>
  );
}

function InfoPanel({
  icon,
  title,
  rows,
}: {
  icon: React.ReactNode;
  title: string;
  rows: [string, string][];
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-[#dfe6f4] bg-white/74 shadow-[0_12px_30px_rgba(44,63,123,0.06)] backdrop-blur-xl">
      <div className="flex items-center gap-2 border-b border-[#e8edf7] px-4 py-3 text-[13px] font-semibold">
        {icon}
        {title}
      </div>
      <div className="divide-y divide-[#e8edf7]">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 px-4 py-3 text-[12px]">
            <div className="font-semibold text-[#384152]">{label}</div>
            <div className="font-[family-name:var(--font-mono)] text-[11px] leading-5 break-words text-[#667085]">
              {value}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
