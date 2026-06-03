"use client";

import React from "react";
import { AlertTriangle, ArrowLeft, Code2, KeyRound, Mail, UserRound } from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
import RippleIcon from "@/components/icons/RippleIcon";
import { useI18n } from "@/i18n";

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
    <IconTile tone="neutral" size="sm" className="absolute top-1/2 left-3.5 -translate-y-1/2">
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
        className={`h-12 w-full rounded-lg border border-[#dfe6f4] bg-white px-3 pr-4 pl-12 text-[16px] leading-6 text-[#101828] transition outline-none focus:border-[#007aff] focus:ring-2 focus:ring-[#007aff]/12 ${mono ? "font-[family-name:var(--font-mono)]" : ""}`}
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
          ? "border-[#007aff]/20 bg-[#eef4ff] text-[#1f5bd8]"
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
  const { t } = useI18n();
  const isInvite = authMode === "invite";
  const isService = authMode === "service";

  const changeMode = (mode: AuthGatewayMode) => {
    onModeChange(mode);
    onAuthErrorClear();
    onAuthUserIdErrorClear();
  };

  const formTitle = isService
    ? t("auth.serviceTitle")
    : isInvite
      ? t("auth.inviteTitle")
      : t("auth.loginTitle");
  const formDescription = isService
    ? t("auth.serviceDescription")
    : isInvite
      ? t("auth.inviteDescription")
      : t("auth.loginDescription");
  const showFormDescription = isInvite || isService;

  return (
    <div
      data-ripple-auth-gateway="true"
      className="min-h-screen w-screen overflow-y-auto bg-[#f2f2f7] text-[#101828]"
    >
      <div className="mx-auto flex min-h-screen w-full max-w-[760px] flex-col px-4 pt-[calc(max(env(safe-area-inset-top),12px)+20px)] pb-[max(env(safe-area-inset-bottom),20px)] sm:px-6 lg:max-w-[880px] lg:pt-[calc(max(env(safe-area-inset-top),16px)+28px)]">
        <header className="flex h-14 shrink-0 items-center">
          <div className="flex items-center gap-3.5">
            <RippleIcon
              size={48}
              className="h-12 w-12 rounded-[14px] shadow-[0_14px_32px_rgba(60,60,67,0.12)]"
            />
            <div className="min-w-0">
              <div
                data-ripple-auth-header-wordmark="true"
                className="text-[15px] leading-5 font-semibold tracking-[0.14em] text-[#007aff]"
              >
                RIPPLE
              </div>
              <div className="text-xs font-medium text-[#667085]">{t("auth.tagline")}</div>
            </div>
          </div>
        </header>

        <main
          data-ripple-auth-main="true"
          className="flex flex-1 -translate-y-6 flex-col items-center justify-center gap-6 py-6 sm:-translate-y-8 sm:gap-7 lg:-translate-y-10 lg:py-10"
        >
          <section className="w-full max-w-[680px] text-center" aria-label="Ripple">
            <h1
              data-ripple-brand-wordmark="true"
              className="relative mx-auto flex max-w-[680px] flex-wrap items-baseline justify-center gap-x-2 text-[36px] leading-[40px] font-semibold tracking-normal text-[#111827] sm:gap-x-3 sm:text-[52px] sm:leading-[56px]"
              aria-label={t("auth.brandPhrase")}
            >
              <span className="inline-block">Flow</span>
              <span
                data-ripple-auth-brand-with="true"
                className="inline-block text-[20px] leading-none font-medium text-[#007aff] italic sm:text-[22px]"
              >
                with
              </span>
              <span className="inline-block">Ripple</span>
              <span
                aria-hidden="true"
                className="absolute right-[12%] -bottom-2 left-[12%] h-2 rounded-full bg-[#007aff]/10 blur-[1px]"
              />
            </h1>
            <div className="mt-3 space-y-1">
              <p className="text-[16px] leading-7 font-medium text-[#384152] sm:text-[17px]">
                {t("auth.sloganPrimary")}
              </p>
              <p className="text-[13px] leading-6 text-[#667085] sm:text-sm">
                {t("auth.sloganSecondary")}
              </p>
            </div>
          </section>

          <section className="w-full max-w-[520px] rounded-2xl border border-[#d7d7dd] bg-white/84 p-5 shadow-[0_24px_70px_rgba(60,60,67,0.10)] backdrop-blur-xl sm:p-6">
            <div className="mb-5 flex items-start gap-3">
              <IconTile tone={isService ? "warning" : "accent"} size="lg">
                {isService ? <Code2 size={18} /> : <UserRound size={18} />}
              </IconTile>
              <div className="min-w-0">
                <h1 className="text-[25px] leading-8 font-semibold tracking-normal text-[#101828]">
                  {formTitle}
                </h1>
                {showFormDescription ? (
                  <p className="mt-1 text-sm leading-6 text-[#667085]">{formDescription}</p>
                ) : null}
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
                  ariaLabel={t("auth.serviceApiKey")}
                  value={keyInput}
                  onChange={onKeyInputChange}
                  placeholder={t("auth.serviceApiKey")}
                  icon={<KeyRound size={16} />}
                  type="password"
                  autoComplete="off"
                  mono
                />
                <div>
                  <TextInput
                    ariaLabel={t("auth.workspaceUserId")}
                    value={authUserIdInput}
                    onChange={(value) => {
                      onAuthUserIdInputChange(value);
                      if (authUserIdError) onAuthUserIdErrorClear();
                    }}
                    placeholder="default"
                    icon={<UserRound size={16} />}
                    autoComplete="username"
                    mono
                  />
                  <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-[#667085]">
                    <span>{t("auth.userIdHelp")}</span>
                    <span className="shrink-0">{t("auth.blankUsesDefault")}</span>
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
                  className="flex h-11 w-full items-center justify-center rounded-lg border border-[#007aff] bg-[#007aff] text-sm font-semibold text-white shadow-[0_12px_28px_rgba(36,99,235,0.18)] transition hover:bg-[#1d56d8] disabled:cursor-not-allowed disabled:border-[#dfe6f4] disabled:bg-[#f2f4f7] disabled:text-[#98a2b3] disabled:shadow-none"
                >
                  {isAuthSubmitting ? t("auth.connecting") : t("auth.connectWithApiKey")}
                </button>
              </form>
            ) : (
              <form onSubmit={isInvite ? onInviteClaim : onPasswordLogin} className="space-y-3">
                {isInvite && (
                  <TextInput
                    ariaLabel={t("auth.inviteCode")}
                    value={inviteCodeInput}
                    onChange={onInviteCodeInputChange}
                    placeholder={t("auth.inviteCode")}
                    icon={<KeyRound size={16} />}
                    autoComplete="one-time-code"
                    mono
                  />
                )}
                <TextInput
                  ariaLabel={t("auth.email")}
                  value={loginInput}
                  onChange={onLoginInputChange}
                  placeholder={t("auth.email")}
                  icon={<Mail size={16} />}
                  type="email"
                  autoComplete="email"
                />
                {isInvite && (
                  <TextInput
                    ariaLabel={t("auth.displayName")}
                    value={inviteDisplayNameInput}
                    onChange={onInviteDisplayNameInputChange}
                    placeholder={t("auth.displayName")}
                    icon={<UserRound size={16} />}
                    autoComplete="name"
                  />
                )}
                <TextInput
                  ariaLabel={t("auth.password")}
                  value={passwordInput}
                  onChange={onPasswordInputChange}
                  placeholder={isInvite ? t("auth.createPassword") : t("auth.password")}
                  icon={<KeyRound size={16} />}
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
                  className="flex h-11 w-full items-center justify-center rounded-lg border border-[#007aff] bg-[#007aff] text-sm font-semibold text-white shadow-[0_12px_28px_rgba(36,99,235,0.18)] transition hover:bg-[#1d56d8] disabled:cursor-not-allowed disabled:border-[#dfe6f4] disabled:bg-[#f2f4f7] disabled:text-[#98a2b3] disabled:shadow-none"
                >
                  {isAuthSubmitting
                    ? t("auth.working")
                    : isInvite
                      ? t("auth.createAccount")
                      : t("auth.signIn")}
                </button>
              </form>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-[#edf2f7] pt-4">
              {isInvite || isService ? (
                <ModeButton onClick={() => changeMode("login")}>
                  <ArrowLeft size={14} />
                  <span className="ml-1.5">{t("auth.backToSignIn")}</span>
                </ModeButton>
              ) : (
                <div className="flex items-center gap-2 text-sm text-[#667085]">
                  <span>{t("auth.haveInviteCode")}</span>
                  <button
                    type="button"
                    onClick={() => changeMode("invite")}
                    className="font-semibold text-[#007aff] hover:text-[#1d56d8]"
                  >
                    {t("auth.createAccount")}
                  </button>
                </div>
              )}

              {!isService && (
                <ModeButton onClick={() => changeMode("service")}>
                  <Code2 size={14} />
                  <span className="ml-1.5">{t("auth.developerAccess")}</span>
                </ModeButton>
              )}
              {isService && (
                <ModeButton active onClick={() => changeMode("service")}>
                  <Code2 size={14} />
                  <span className="ml-1.5">{t("auth.developerAccess")}</span>
                </ModeButton>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
