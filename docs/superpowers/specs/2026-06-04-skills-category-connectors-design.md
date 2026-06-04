# Skills Category and Connector Merge

## Context

The current Skills page groups entries by source and connector, but the experience still feels like a long management list. Users have to scroll and expand groups to understand what is available. Statuses such as available, not enabled, needs connection, and needs fix are useful, but they should not be the primary navigation model.

The current Connectors page is a separate top-level "Links" tab. It manages the same service concepts that appear in Skills: Feishu / Lark, Google Workspace, Bilibili, Notion, and general runtime availability. Keeping it separate makes the product harder to understand because users must learn that "skills" and "connectors" are two different places even though connector state directly affects skill usability.

## Decision

Redesign the Skills page as the single "Capabilities" surface:

- Keep the existing simple category structure:
  - "Mine" / "Custom"
  - "System built-in" / Feishu / Lark, Google Workspace, Bilibili, Notion, General
- Do not use enabled, disabled, needs connection, or needs fix as page sections.
- Add lightweight search and filter controls above the category list.
- Merge connector management into the relevant capability category.
- Remove the standalone Connectors / Links tab from the main desktop and mobile navigation once the merged surface covers connection, disconnect, and account management.

This keeps the first screen compact and recognizable while making service connection state visible exactly where it matters.

## User Experience

The first screen is a category index, close to the current simplified layout:

- Header: "Skills" / "能力", overall available count, create button, refresh button.
- Search field: searches skill name, display name, description, category, and connector/service label.
- Filter entry: opens a compact filter menu or sheet. The default state has no status filter applied.
- Section: "Mine" with a "Custom" row.
- Section: "System built-in" with rows for Feishu / Lark, Google Workspace, Bilibili, Notion, and General.

Each category row shows:

- Chevron or disclosure icon.
- Category name.
- Availability count such as `7/7 available`.
- Connector status only when relevant:
  - Connected
  - Needs connection
  - Not connected
  - No connection needed
- A short account count for Google Workspace when accounts are available, for example `1 account`.

Clicking a category opens a category detail view rather than expanding many cards on the index. The detail view contains:

- Back button and category title.
- Connector status panel when the category maps to a user connector.
- Connection action when disconnected.
- Disconnect action and local account removal actions where supported.
- Search within the category.
- The same filter controls scoped to the current category.
- Dense skill rows for that category.

Skill rows should stay compact by default. Details and destructive actions appear after opening or expanding a row, not in every list item on the first screen.

## Filters

Filters are secondary controls, not categories.

Initial filters:

- Source: all, mine, system.
- Service/category: all, custom, Feishu / Lark, Google Workspace, Bilibili, Notion, general.
- Status: all, available, enabled, not enabled, needs connection, needs fix, unavailable.

The category index itself should not split by these statuses. If a status filter is active, category counts and detail lists reflect the filter, and the UI shows an active filter pill or summary near the search field.

## Connector Merge

Connector information becomes part of the capability category model:

- Feishu / Lark category uses the Feishu connector status and auth action.
- Google Workspace category uses Google connector status, auth action, and account list.
- Bilibili category uses Bilibili connector status and auth action.
- Notion category uses Notion connector status and local token disconnect action.
- General category has no connector management panel.

The merged UI should reuse the existing connector behavior:

- Continue delegating auth starts through `onOpenSessionAction`.
- Do not open external auth windows inside the page.
- Do not render Bilibili QR codes inside the page; the session flow owns that.
- Keep local disconnect confirmation for destructive connector operations.
- Preserve Google per-account local removal.

Backend APIs remain unchanged. The frontend fetches `/v1/skills` for skill entries and uses the existing connector/capability helper path for connector status and Google account data, then derives category rows client-side.

## Navigation

Once connector management is available inside the Skills page:

- Remove `connectors` from desktop `mainNavItems`.
- Remove `connectors` from mobile `mobileNavItems`.
- Keep routing/state handling robust if an old in-memory view still references `connectors`; it can redirect to `skills` or render the merged Skills page.
- Update labels so the user-facing concept is "Skills" / "能力", not two separate Skills and Links destinations.

## Non-Goals

- Do not change Rust backend response shapes.
- Do not change connector auth, polling, QR, OAuth, or disconnect APIs.
- Do not add a marketplace, publisher model, downloads, stars, or public plugin discovery.
- Do not make enabled/disabled status a first-level navigation structure.
- Do not add bulk skill operations in this pass.
- Do not move server-side control-plane logic into the frontend.

## Component Scope

Expected frontend changes:

- `app/src/components/workbench/SkillsPage.tsx`
  - New category index and category detail state.
  - Search and filter state.
  - Connector status/actions merged into category details.
- `app/src/components/workbench/ConnectorsPage.tsx`
  - Retire as a routed top-level page after the merged Skills page owns connector management.
  - Extract small reusable connector helpers only if that keeps the Skills implementation clear.
- `app/src/lib/workspaceViews.ts`
  - Remove the standalone connectors nav item after merged behavior exists.
- `app/src/App.tsx`
  - Route old connector view state to skills or remove direct rendering of `ConnectorsPage`.
- `app/src/i18n/index.tsx`
  - Add labels for filters, category detail, connection status, and merged connector management.
- Focused tests in Skills, Connectors/navigation, and mobile tab bar areas.

If helper extraction is needed, prefer a small local helper module over a broad design-system refactor.

## Mobile Behavior

Mobile uses the same model without a side rail:

- Top header and search.
- Filter button opens a bottom sheet or compact menu.
- Category rows are full-width touch targets.
- Category detail is a drill-in view with a back button.
- Connector account management remains below the connector status panel and above skill rows.

No bottom navigation slot should be spent on a separate connector page after merge.

## Testing

Focused tests should cover:

- Skills page renders the category index with Mine / Custom and System built-in service categories.
- Status labels are not rendered as top-level source sections.
- Search/filter controls exist and can be represented in source.
- Connector auth still routes through `onOpenSessionAction`.
- Connector disconnect/account removal confirmations are still present where supported.
- Desktop and mobile navigation no longer include a standalone connectors tab after merge.
- Chinese and English chrome render the simplified category labels.

Manual verification should include:

- Desktop and mobile screenshots of the category index.
- Category detail for connected Google Workspace with account list.
- Category detail for disconnected Bilibili or Notion with connect action.
- Search and filter combinations that produce no results.
- Text fit for long category names and account emails.
