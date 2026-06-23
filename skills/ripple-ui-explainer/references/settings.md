# Ripple Settings Page

Use this for Settings screenshots: profile/avatar, Defaults, Default model, language, usage/storage, diagnostics, and personal preferences.

## Code Sources

- `app/src/components/workbench/SettingsPage.tsx`
- `app/src/App.tsx`
- `app/src/lib/modelPreference.ts`
- `app/src/lib/api.ts`

## Page Meaning

Settings is user-scoped. Most controls affect the current Ripple user or current browser/app preference, not every user in the server.

Desktop users usually open Settings from the avatar/profile button in `ProductTopBar`. Mobile users see Settings as the `home` item in `mobileNavItems`.

## Profile And Avatar

Visible clues:

- Avatar/profile block.
- Upload avatar or remove avatar actions.

Behavior:

- Upload avatar calls `uploadUserAvatar(file)`.
- Remove avatar calls `deleteUserAvatar()`.
- The avatar menu is rendered as a desktop portal or a mobile action sheet.
- These actions change the current user's profile display state.

## Defaults: Default Model

Visible clues:

- Defaults section.
- Row labeled Default model.
- Button showing Lite/Plus/Pro/Ultra with a chevron.

Behavior:

- Desktop opens a menu.
- Mobile opens `MobileActionSheet` with `data-ripple-settings-model-sheet`.
- Choosing an option calls `handleSelectDefaultModel(model)` in `App.tsx`.
- `handleSelectDefaultModel` persists the preference through `persistDefaultModel`, sets `selectedModel`, and remembers an override.
- It does not start a run and does not directly call `updateSessionById`.
- Read `model-selection.md` before explaining the model choices.

## Language

Visible clue:

- Language row in Defaults.

Behavior:

- Changes display language/localization preference for the app.
- It should not change server-side task execution or Codex model behavior by itself.

## Usage, Storage, Sessions, Diagnostics

Visible clues:

- Metric tiles, workspace storage meter, session counts, runtime/diagnostic sections.

Behavior:

- These are mostly informational.
- Refresh-like controls reload current user/server state.
- Storage limit relates to the user's workspace capacity.
- Diagnostics describe runtime/service health; do not treat them as user content.

## How To Answer

For Settings controls, say whether the action changes:

- current user profile,
- browser/app preference,
- default model preference,
- visible language,
- or only displays current status.

Settings actions are not task execution unless the visible UI explicitly starts a diagnostic or run.
