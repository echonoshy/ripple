# Ripple Sessions And Composer

Use this for screenshots of the chat page, composer toolbar, message timeline, screenshots/files in the draft, and current model or folder badges.

## Code Sources

- `app/src/components/workbench/SessionPage.tsx`
- `app/src/components/workbench/SessionComposer.tsx`
- `app/src/hooks/useChatRun.ts`
- `app/src/hooks/chatRunAttachments.ts`
- `app/src/lib/api.ts`

## Page Meaning

Sessions are the main conversation surface. A session is not just visible chat text: it can include user messages, assistant messages, Codex run events, approvals, connector auth prompts, file references, generated artifacts, and a persistent Codex thread.

Screenshots pasted into the composer become part of the formal conversation once the user sends the message. The user can then ask follow-up questions about that screenshot in the same session.

## Composer Controls

### Text Box

Visible clue: large input at the bottom with placeholder text like "Ask anything".

Behavior:

- Text is held in composer state until sent.
- Pressing send packages text plus pending files/images into the next chat request.
- Empty text can still be sent if there are pending files or images.

### Send Button

Visible clue: blue button with Send icon.

Behavior:

- Calls the page send handler, which uses the currently selected model and pending attachments.
- If no session exists, App can create a new session before sending.
- Sends through the Ripple responses/chat path; user-visible result is a normal conversation turn.
- Disabled while there is no content, while uploading, or while the run is blocked/generating.

### Stop Button

Visible clue: red-tinted square button replacing Send while work is running or blocked.

Behavior:

- Calls `onStop`.
- It requests stopping the current generation/run. It does not delete prior messages.

### Work Folder Button

Visible clue: folder icon, `data-ripple-composer-folder-button`.

Behavior:

- Opens `WorkspaceFolderPicker`.
- The picker uses `fetchWorkspaceListing` to browse workspace folders.
- Selecting a folder sets the session/work context folder through `onSelectWorkspaceFolder`.
- A folder scope means future chat should focus on that workspace folder; no folder means the full workspace.
- In `SessionPage.tsx`, the header folder badge can trigger the same picker by clicking the composer folder button.

Exact expected answer:

- This is the Choose work folder button.
- Clicking it opens the work folder picker.
- The picker selects a workspace folder/directory as the current chat's focus folder.
- It does not upload a local file, does not attach a file to the draft, does not pick an individual file as an attachment, and does not send a message.
- Do not describe this button as attaching a file or adding a workspace file to the prompt. The adjacent Paperclip button is the attach/upload-file control.

### Attach Files Button

Visible clue: paperclip icon.

Behavior:

- Opens the hidden file input.
- Normal files become pending file attachments via `onAttachFiles`.
- Uploading shows a spinner and can show `uploadError`.
- Pending file chips can be removed before send.

### Paste Or Drop Files

Code anchors:

- `partitionTransferFiles`
- `pendingLocalImages`
- `uploadPendingLocalImagesForSend`

Behavior:

- Pasted or dropped images are kept as `pendingLocalImages` with local previews.
- Other pasted/dropped files go through `onAttachFiles`.
- On send, `uploadPendingLocalImagesForSend` uploads pending images before the chat request is made.
- Uploaded screenshots/images are sent as file references in the formal conversation, not as a separate hidden side channel.
- If upload fails, the message should not be treated as successfully sent with that image.

### Model Button

Visible clue: BrainCircuit icon near the composer controls, `data-ripple-composer-model-button`.

Behavior:

- Opens `data-ripple-composer-model-menu`.
- This is the per-composer model preset selector. Read `model-selection.md` for exact Lite/Plus/Pro/Ultra behavior.

Exact expected answer:

- This is the Select model button in the bottom composer toolbar.
- Clicking it opens a model preset menu, usually with Lite, Plus, Pro, and Ultra.
- Picking an option changes the model preset for the next response and remembers it as the app's default preference.
- If the current session is already stored, Ripple also updates that session's model metadata.
- It does not open the Skills page, does not create a skill, does not choose a skill/workflow, and does not send a message.

## Current Model Badge

Visible clue: small BrainCircuit badge near the session header, often showing Lite/Plus/Pro/Ultra.

Behavior:

- In `SessionPage.tsx`, `data-ripple-current-model-badge` is display-only.
- It tells the user which model preset is currently selected for the session view.
- It is not the dropdown itself; the composer BrainCircuit button opens the selector.

## Timeline And Attachments

The timeline can show messages, events, file links, images, run progress, and downloaded workspace previews. If a screenshot shows a file link or generated artifact, do not assume the file is still present unless the UI shows it successfully opened.

## How To Answer

For composer questions, include:

- What the visible control is.
- What UI opens or changes after click.
- Whether it stays local until send or persists immediately.
- Whether the action starts Codex execution.
- Whether upload or connector authorization could block it.
