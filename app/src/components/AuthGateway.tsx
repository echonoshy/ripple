"use client";

import React from "react";
import { AlertTriangle, ArrowLeft, Code2, KeyRound, Mail, UserRound } from "lucide-react";
import { IconTile } from "@/components/icons/IconTile";
import RippleIcon from "@/components/icons/RippleIcon";
import { useI18n } from "@/i18n";
import { WORKBENCH_FLOATING_SURFACE_CLASS } from "@/components/workbench/stylePrimitives";

export type AuthGatewayMode = "login" | "invite" | "service";

const PRIMARY_ACTION_BUTTON_CLASS =
  "flex h-11 w-full items-center justify-center rounded-lg border border-[#1456F0] bg-[#1456F0] text-sm font-semibold text-white shadow-[0_12px_28px_rgba(20,86,240,0.18)] transition-[background-color,border-color,box-shadow] duration-200 ease-out hover:bg-[#0F4BD8] hover:shadow-[0_16px_34px_rgba(20,86,240,0.22)] disabled:cursor-not-allowed disabled:border-[#DEE0E3] disabled:bg-[#EFF0F1] disabled:text-[#8F959E] disabled:shadow-none motion-reduce:transition-none";

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
        className={`h-12 w-full rounded-lg border border-[#DEE0E3] bg-white px-3 pr-4 pl-12 text-[16px] leading-6 text-[#1F2329] shadow-[0_1px_0_rgba(255,255,255,0.75)_inset] transition-[border-color,box-shadow,transform] duration-200 ease-out outline-none hover:border-[#D0D3D6] hover:shadow-[0_8px_22px_rgba(15,23,42,0.06)] focus:border-[#1456F0] focus:shadow-[0_0_0_4px_rgba(20,86,240,0.08),0_10px_24px_rgba(15,23,42,0.08)] focus:ring-2 focus:ring-[#1456F0]/12 motion-reduce:transition-none ${mono ? "font-[family-name:var(--font-mono)]" : ""}`}
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
      className={`inline-flex h-9 items-center justify-center rounded-lg border px-3 text-sm font-semibold transition-[background-color,border-color,box-shadow] duration-200 ease-out motion-reduce:transition-none ${
        active
          ? "border-[#1456F0]/20 bg-[#F0F5FF] text-[#1456F0] shadow-[0_8px_20px_rgba(20,86,240,0.10)]"
          : "border-[#DEE0E3] bg-white text-[#2B2F36] shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-[#D0D3D6] hover:bg-[#F8F9FA] hover:shadow-[0_10px_24px_rgba(15,23,42,0.07)]"
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
      className="relative isolate min-h-screen w-screen overflow-y-auto bg-[#F5F6F7] text-[#1F2329]"
    >
      <div
        data-ripple-auth-ambient="true"
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[58vh] bg-[linear-gradient(180deg,rgba(20,86,240,0.07)_0%,rgba(255,255,255,0.46)_48%,rgba(245,246,247,0)_100%)]"
      />
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[760px] flex-col px-4 pt-[calc(max(env(safe-area-inset-top),12px)+20px)] pb-[max(env(safe-area-inset-bottom),20px)] sm:px-6 lg:max-w-[880px] lg:pt-[calc(max(env(safe-area-inset-top),16px)+28px)]">
        <header className="flex h-14 shrink-0 items-center">
          <div className="flex items-center gap-3.5">
            <RippleIcon
              size={48}
              className="h-12 w-12 rounded-[14px] shadow-[0_18px_38px_rgba(15,23,42,0.16)]"
            />
            <div className="min-w-0">
              <div
                data-ripple-auth-header-wordmark="true"
                className="text-[15px] leading-5 font-semibold tracking-[0.14em] text-[#1456F0]"
              >
                RIPPLE
              </div>
              <div className="text-xs font-medium text-[#646A73]">{t("auth.tagline")}</div>
            </div>
          </div>
        </header>

        <main
          data-ripple-auth-main="true"
          className="flex flex-1 -translate-y-6 flex-col items-center justify-center gap-6 py-6 sm:-translate-y-8 sm:gap-7 lg:-translate-y-10 lg:py-10"
        >
          <section
            className="w-full max-w-[680px] text-center"
            aria-label="Ripple"
          >
            <h1
              data-ripple-brand-wordmark="true"
              className="relative mx-auto flex max-w-[680px] flex-wrap items-baseline justify-center gap-x-2 text-[36px] leading-[40px] font-semibold tracking-normal text-[#1F2329] sm:gap-x-3 sm:text-[52px] sm:leading-[56px]"
              aria-label={t("auth.brandPhrase")}
            >
              <span className="inline-block">Flow</span>
              <span
                data-ripple-auth-brand-with="true"
                className="inline-block text-[20px] leading-none font-medium text-[#1456F0] italic sm:text-[22px]"
              >
                with
              </span>
              <span className="inline-block">Ripple</span>
              <span
                aria-hidden="true"
                className="absolute right-[12%] -bottom-2 left-[12%] h-2 rounded-full bg-[#1456F0]/10 blur-[1px]"
              />
            </h1>
            <div className="mt-3 space-y-1">
              <p className="text-[16px] leading-7 font-medium text-[#2B2F36] sm:text-[17px]">
                {t("auth.sloganPrimary")}
              </p>
              <p className="text-[13px] leading-6 text-[#646A73] sm:text-sm">
                {t("auth.sloganSecondary")}
              </p>
            </div>
          </section>

          <section
            data-ripple-auth-card="true"
            className={`w-full max-w-[520px] p-5 transition-[border-color,box-shadow] duration-200 ease-out hover:border-[#D0D3D6] motion-reduce:transform-none motion-reduce:transition-none sm:p-6 ${WORKBENCH_FLOATING_SURFACE_CLASS}`}
          >
            <div className="mb-5 flex items-start gap-3">
              <IconTile tone={isService ? "warning" : "accent"} size="lg">
                {isService ? <Code2 size={18} /> : <UserRound size={18} />}
              </IconTile>
              <div className="min-w-0">
                <h1 className="text-[25px] leading-8 font-semibold tracking-normal text-[#1F2329]">
                  {formTitle}
                </h1>
                {showFormDescription ? (
                  <p className="mt-1 text-sm leading-6 text-[#646A73]">{formDescription}</p>
                ) : null}
              </div>
            </div>

            {authErrorMsg && (
              <div
                role="alert"
                className="mb-4 flex items-start gap-3 rounded-lg border border-[#B42318]/25 bg-[#FFF1F0] p-3 text-sm font-medium text-[#B42318]"
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
                  <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-[#646A73]">
                    <span>{t("auth.userIdHelp")}</span>
                    <span className="shrink-0">{t("auth.blankUsesDefault")}</span>
                  </div>
                  {authUserIdError && (
                    <div role="alert" className="mt-2 text-xs font-semibold text-[#B42318]">
                      {authUserIdError}
                    </div>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={isAuthSubmitting || !keyInput.trim()}
                  className={PRIMARY_ACTION_BUTTON_CLASS}
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
                  className={PRIMARY_ACTION_BUTTON_CLASS}
                >
                  {isAuthSubmitting
                    ? t("auth.working")
                    : isInvite
                      ? t("auth.createAccount")
                      : t("auth.signIn")}
                </button>
              </form>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-[#EFF0F1] pt-4">
              {isInvite || isService ? (
                <ModeButton onClick={() => changeMode("login")}>
                  <ArrowLeft size={14} />
                  <span className="ml-1.5">{t("auth.backToSignIn")}</span>
                </ModeButton>
              ) : (
                <div className="flex items-center gap-2 text-sm text-[#646A73]">
                  <span>{t("auth.haveInviteCode")}</span>
                  <button
                    type="button"
                    onClick={() => changeMode("invite")}
                    className="font-semibold text-[#1456F0] hover:text-[#0F4BD8]"
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
