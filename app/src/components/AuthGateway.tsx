"use client";

import React from "react";
import { AlertTriangle, ArrowLeft, Code2, KeyRound, UserRound } from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
import RippleIcon from "@/components/icons/RippleIcon";

export type AuthGatewayMode = "login" | "invite" | "service";

interface AuthGatewayProps {
  authMode: AuthGatewayMode;
  authErrorMsg: string;
  isAuthSubmitting: boolean;
  loginInput: string;
  passwordInput: string;
  inviteCodeInput: string;
  inviteDisplayNameInput: string;
  keyInput: string;
  authUserIdInput: string;
  authUserIdError: string | null;
  onModeChange: (mode: AuthGatewayMode) => void;
  onAuthErrorClear: () => void;
  onAuthUserIdErrorClear: () => void;
  onLoginInputChange: (value: string) => void;
  onPasswordInputChange: (value: string) => void;
  onInviteCodeInputChange: (value: string) => void;
  onInviteDisplayNameInputChange: (value: string) => void;
  onKeyInputChange: (value: string) => void;
  onAuthUserIdInputChange: (value: string) => void;
  onPasswordLogin: (event: React.FormEvent) => void;
  onInviteClaim: (event: React.FormEvent) => void;
  onServiceAuth: (event: React.FormEvent) => void;
}

function FieldIcon({ children }: { children: React.ReactNode }) {
  return (
    <IconTile tone="neutral" size="xs" className="absolute top-1/2 left-3 -translate-y-1/2">
      {children}
    </IconTile>
  );
}

interface TextInputProps {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  icon: React.ReactNode;
  type?: React.HTMLInputTypeAttribute;
  autoComplete?: string;
  mono?: boolean;
}

function TextInput({
  ariaLabel,
  value,
  onChange,
  placeholder,
  icon,
  type = "text",
  autoComplete,
  mono = false,
}: TextInputProps) {
  return (
    <div className="relative">
      <FieldIcon>{icon}</FieldIcon>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={`h-11 w-full rounded-lg border border-[#dfe6f4] bg-white px-3 pr-4 pl-11 text-sm text-[#101828] transition outline-none focus:border-[#2463eb] focus:ring-2 focus:ring-[#2463eb]/12 ${mono ? "font-[family-name:var(--font-mono)]" : ""}`}
      />
    </div>
  );
}

function ModeButton({
  children,
  onClick,
  active = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center justify-center rounded-lg border px-3 text-sm font-semibold transition ${
        active
          ? "border-[#2463eb]/20 bg-[#eef4ff] text-[#1f5bd8]"
          : "border-[#dfe6f4] bg-white text-[#344054] hover:border-[#cbd7ea] hover:bg-[#f8fafc]"
      }`}
    >
      {children}
    </button>
  );
}

export default function AuthGateway({
  authMode,
  authErrorMsg,
  isAuthSubmitting,
  loginInput,
  passwordInput,
  inviteCodeInput,
  inviteDisplayNameInput,
  keyInput,
  authUserIdInput,
  authUserIdError,
  onModeChange,
  onAuthErrorClear,
  onAuthUserIdErrorClear,
  onLoginInputChange,
  onPasswordInputChange,
  onInviteCodeInputChange,
  onInviteDisplayNameInputChange,
  onKeyInputChange,
  onAuthUserIdInputChange,
  onPasswordLogin,
  onInviteClaim,
  onServiceAuth,
}: AuthGatewayProps) {
  const isInvite = authMode === "invite";
  const isService = authMode === "service";

  const changeMode = (mode: AuthGatewayMode) => {
    onModeChange(mode);
    onAuthErrorClear();
    onAuthUserIdErrorClear();
  };

  const formTitle = isService
    ? "Developer access"
    : isInvite
      ? "Create your workspace access"
      : "Sign in to Ripple";
  const formDescription = isService
    ? "Use a service API key for development or controlled deployments."
    : isInvite
      ? "Claim an invitation and choose credentials for this workspace."
      : "Use your account credentials to continue.";

  return (
    <div
      data-ripple-auth-gateway="true"
      className="min-h-screen w-screen overflow-y-auto bg-[#f6f8fb] text-[#101828]"
    >
      <div className="mx-auto flex min-h-screen w-full max-w-[520px] flex-col px-4 py-5 sm:px-6">
        <header className="flex h-12 shrink-0 items-center justify-between">
          <div className="flex items-center gap-3">
            <RippleIcon
              size={38}
              className="h-9 w-9 rounded-xl shadow-[0_12px_28px_rgba(13,13,13,0.14)]"
            />
            <div className="min-w-0">
              <div className="text-base leading-5 font-semibold">Ripple</div>
              <div className="text-xs font-medium text-[#667085]">Your AI workspace</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => changeMode("service")}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#dfe6f4] bg-white px-3 text-sm font-semibold text-[#344054] shadow-[0_8px_22px_rgba(44,63,123,0.06)] transition hover:border-[#cbd7ea] hover:bg-[#f8fafc]"
          >
            <Code2 size={15} />
            <span className="hidden sm:inline">Developer access</span>
          </button>
        </header>

        <main className="flex flex-1 items-center justify-center py-5">
          <section className="w-full rounded-xl border border-[#dfe6f4] bg-white p-5 shadow-[0_24px_70px_rgba(44,63,123,0.12)] sm:p-6">
            <div className="mb-5 flex items-start gap-3">
              <IconTile tone={isService ? "warning" : "accent"} size="lg">
                {isService ? <Code2 size={18} /> : <UserRound size={18} />}
              </IconTile>
              <div className="min-w-0">
                <h1 className="text-[25px] leading-8 font-semibold tracking-normal text-[#101828]">
                  {formTitle}
                </h1>
                <p className="mt-1 text-sm leading-6 text-[#667085]">{formDescription}</p>
              </div>
            </div>

            {authErrorMsg && (
              <div
                role="alert"
                className="mb-4 flex items-start gap-3 rounded-lg border border-[#cf222e]/25 bg-[#fff1f0] p-3 text-sm font-medium text-[#b42318]"
              >
                <IconTile tone="danger" size="sm">
                  <AlertTriangle size={14} />
                </IconTile>
                <span className="min-w-0">{authErrorMsg}</span>
              </div>
            )}

            {isService ? (
              <form onSubmit={onServiceAuth} className="space-y-3">
                <TextInput
                  ariaLabel="Service API key"
                  value={keyInput}
                  onChange={onKeyInputChange}
                  placeholder="Service API key"
                  icon={<KeyRound size={13} />}
                  type="password"
                  autoComplete="off"
                  mono
                />
                <div>
                  <TextInput
                    ariaLabel="Workspace user ID"
                    value={authUserIdInput}
                    onChange={(value) => {
                      onAuthUserIdInputChange(value);
                      if (authUserIdError) onAuthUserIdErrorClear();
                    }}
                    placeholder="default"
                    icon={<UserRound size={13} />}
                    autoComplete="username"
                    mono
                  />
                  <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-[#667085]">
                    <span>User ID determines the isolated workspace sandbox.</span>
                    <span className="shrink-0">Blank uses default.</span>
                  </div>
                  {authUserIdError && (
                    <div className="mt-2 text-xs font-semibold text-[#b42318]">
                      {authUserIdError}
                    </div>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={isAuthSubmitting || !keyInput.trim()}
                  className="flex h-11 w-full items-center justify-center rounded-lg border border-[#2463eb] bg-[#2463eb] text-sm font-semibold text-white shadow-[0_12px_28px_rgba(36,99,235,0.18)] transition hover:bg-[#1d56d8] disabled:cursor-not-allowed disabled:border-[#dfe6f4] disabled:bg-[#f2f4f7] disabled:text-[#98a2b3] disabled:shadow-none"
                >
                  {isAuthSubmitting ? "Connecting..." : "Connect with API key"}
                </button>
              </form>
            ) : (
              <form onSubmit={isInvite ? onInviteClaim : onPasswordLogin} className="space-y-3">
                {isInvite && (
                  <TextInput
                    ariaLabel="Invite code"
                    value={inviteCodeInput}
                    onChange={onInviteCodeInputChange}
                    placeholder="Invite code"
                    icon={<KeyRound size={13} />}
                    autoComplete="one-time-code"
                    mono
                  />
                )}
                <TextInput
                  ariaLabel="Email or username"
                  value={loginInput}
                  onChange={onLoginInputChange}
                  placeholder="Email or username"
                  icon={<UserRound size={13} />}
                  autoComplete="username"
                />
                {isInvite && (
                  <TextInput
                    ariaLabel="Display name"
                    value={inviteDisplayNameInput}
                    onChange={onInviteDisplayNameInputChange}
                    placeholder="Display name"
                    icon={<UserRound size={13} />}
                    autoComplete="name"
                  />
                )}
                <TextInput
                  ariaLabel="Password"
                  value={passwordInput}
                  onChange={onPasswordInputChange}
                  placeholder={isInvite ? "Create password" : "Password"}
                  icon={<KeyRound size={13} />}
                  type="password"
                  autoComplete={isInvite ? "new-password" : "current-password"}
                />
                <button
                  type="submit"
                  disabled={
                    isAuthSubmitting ||
                    !loginInput.trim() ||
                    !passwordInput ||
                    (isInvite && !inviteCodeInput.trim())
                  }
                  className="flex h-11 w-full items-center justify-center rounded-lg border border-[#2463eb] bg-[#2463eb] text-sm font-semibold text-white shadow-[0_12px_28px_rgba(36,99,235,0.18)] transition hover:bg-[#1d56d8] disabled:cursor-not-allowed disabled:border-[#dfe6f4] disabled:bg-[#f2f4f7] disabled:text-[#98a2b3] disabled:shadow-none"
                >
                  {isAuthSubmitting ? "Working..." : isInvite ? "Create account" : "Sign in"}
                </button>
              </form>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-[#edf2f7] pt-4">
              {isInvite || isService ? (
                <ModeButton onClick={() => changeMode("login")}>
                  <ArrowLeft size={14} />
                  <span className="ml-1.5">Back to sign in</span>
                </ModeButton>
              ) : (
                <div className="flex items-center gap-2 text-sm text-[#667085]">
                  <span>Have an invite code?</span>
                  <button
                    type="button"
                    onClick={() => changeMode("invite")}
                    className="font-semibold text-[#2463eb] hover:text-[#1d56d8]"
                  >
                    Create account
                  </button>
                </div>
              )}

              {!isService && (
                <ModeButton onClick={() => changeMode("service")}>
                  <Code2 size={14} />
                  <span className="ml-1.5">Developer access</span>
                </ModeButton>
              )}
              {isService && (
                <ModeButton active onClick={() => changeMode("service")}>
                  <Code2 size={14} />
                  <span className="ml-1.5">Developer access</span>
                </ModeButton>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
