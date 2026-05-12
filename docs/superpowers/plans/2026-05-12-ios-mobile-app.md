# iOS Mobile App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first Expo/React Native mobile client for Ripple, focused on iOS usage while keeping the existing FastAPI server as the only backend.

**Architecture:** Add a standalone app under `src/interfaces/mobile`. The app stores server connection settings locally, calls the current `/v1` Ripple API, renders chat/session state, and handles AskUser plus permission confirmations without changing the backend.

**Tech Stack:** Expo, React Native, TypeScript, React Native Testing Library style utilities where useful, Node test runner for pure TypeScript behavior.

---

### Task 1: Mobile App Scaffold

**Files:**
- Create: `src/interfaces/mobile/package.json`
- Create: `src/interfaces/mobile/app.json`
- Create: `src/interfaces/mobile/tsconfig.json`
- Create: `src/interfaces/mobile/babel.config.js`
- Create: `src/interfaces/mobile/App.tsx`

- [ ] Create a minimal Expo TypeScript app that can run on iOS.
- [ ] Keep it independent from the existing Next.js web app.
- [ ] Add scripts for `start`, `ios`, `android`, `test`, and `typecheck`.

### Task 2: Ripple API Client

**Files:**
- Create: `src/interfaces/mobile/src/api/types.ts`
- Create: `src/interfaces/mobile/src/api/rippleClient.ts`
- Create: `src/interfaces/mobile/src/api/rippleClient.test.ts`

- [ ] Test request URL/header construction before implementation.
- [ ] Implement `listModels`, `createSession`, `listSessions`, `getSession`, `stopSession`, `resolvePermission`, and `streamChat`.
- [ ] Support the same auth headers as web: `Authorization: Bearer <apiKey>` and `X-Ripple-User-Id`.

### Task 3: Settings And Local State

**Files:**
- Create: `src/interfaces/mobile/src/storage/settings.ts`
- Create: `src/interfaces/mobile/src/storage/settings.test.ts`

- [ ] Test validation/defaults first.
- [ ] Store `serverUrl`, `apiKey`, `userId`, `model`, and `thinkingEnabled`.
- [ ] Use a small abstraction so AsyncStorage can be swapped or mocked.

### Task 4: Chat UI

**Files:**
- Create: `src/interfaces/mobile/src/components/ChatMessage.tsx`
- Create: `src/interfaces/mobile/src/components/ChatInput.tsx`
- Create: `src/interfaces/mobile/src/components/PermissionCard.tsx`
- Create: `src/interfaces/mobile/src/components/ToolCallSummary.tsx`
- Modify: `src/interfaces/mobile/App.tsx`

- [ ] Build a single-screen mobile chat flow.
- [ ] Render Markdown-ish plain text safely for the first version.
- [ ] Show AskUser options and permission actions inline.
- [ ] Show tool calls as compact collapsible summaries.

### Task 5: Verification

**Files:**
- Modify: `src/interfaces/mobile/README.md`

- [ ] Run mobile unit tests.
- [ ] Run TypeScript typecheck.
- [ ] Document iOS launch command and the server URL caveat: phone cannot use the laptop's `localhost`.
