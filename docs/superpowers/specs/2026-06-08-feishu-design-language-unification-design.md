# Spec: Feishu-Style Design Language Unification

## Context

Ripple is the agent control plane for Codex app-server. Its Web and Tauri mobile clients share the same Vite + React application under `app/`. The current app structure is fixed for this work:

- Desktop keeps the existing `ProductTopBar`, session rail, main content, and optional inspector panel.
- Mobile keeps the existing first-level bottom tabs and second-level/detail top return pattern.
- The Ripple brand logo and brand identity remain unchanged.
- Server behavior, API contracts, connector flows, and app navigation structure are out of scope.

The current UI already uses several values that match Feishu/Lark and Universe Design: brand blue `#1456F0`, gray text colors such as `#1F2329` and `#646A73`, light borders such as `#DEE0E3`, lucide line icons, and compact 12/14/16px typography. The main inconsistency is visual tone. Many surfaces use iOS-style glass classes, blur, heavy floating shadows, large pills, and `rounded-2xl`/`rounded-full` treatments. That makes Ripple feel more like a floating mobile utility than a restrained collaborative work app.

## Direction

Use the approved **Route A: Feishu-style collaborative workbench convergence**.

The target experience should feel:

- Clear, restrained, and work-focused.
- Dense enough for repeated scanning and operational workflows.
- Consistent across Web and mobile without changing the existing information architecture.
- Integrated with Feishu/Lark-style collaborative app conventions: predictable navigation, concise labels, direct feedback, and minimal visual noise.

The main app should use light gray backgrounds, white work surfaces, one-pixel keylines, restrained shadows, moderate radius, and semantic status colors. Glass, blur, and stronger shadows should be reserved for true floating layers such as mobile sheets, popovers, modals, and dropdowns.

## Non-Goals

- Do not change the Web or mobile app structure.
- Do not change the Ripple logo or app icon assets.
- Do not introduce a new frontend framework or component library.
- Do not move server or control-plane logic into the frontend.
- Do not redesign backend APIs, connector auth flows, schedules, sessions, runs, or workspace data behavior.
- Do not create marketing pages, decorative hero sections, decorative gradients, or large illustrative surfaces.
- Do not do unrelated refactors outside the visual language work.

## Design Sources

This design aligns to the Feishu/Lark design language themes already referenced in `AGENTS.md`:

- Feishu design app overview: apps should fit the native Feishu experience and improve user satisfaction.
- Feishu typography: systematic font weights, sizes, line heights, and text colors for readability and efficiency.
- Feishu icon guidance: icons should be accurate, simple, consistent, readable at small sizes, and lighter than adjacent text when paired.
- Feishu navigation guidance: top and side navigation should preserve brand/title, primary navigation, and utility areas, with responsive reduction based on information priority.
- Semi Design Tokens: tokenization should decouple foundational visual values from component usage.

## Current-State Findings

### Already Close

- `app/src/components/workbench/stylePrimitives.ts` already contains Feishu-like color primitives, typography classes, and lucide stroke constants.
- `app/src/globals.css` already mirrors those colors as CSS variables and uses a strong cross-platform font stack.
- `motionPrimitives.ts` already supports mobile-friendly quick response and smooth release behaviors.
- Mobile navigation already follows the required bottom-tab plus detail-return pattern.
- Most page components use lucide icons and restrained text hierarchy rather than marketing composition.

### Main Gaps

- Existing primitive names and classes are still oriented around `COMPACT_IOS_*` and `GLASS_*`.
- `bg-white/70-96`, `backdrop-blur-*`, and heavy shadows are used on many primary surfaces rather than only on floating layers.
- Navigation selected states rely on strong blue pills and shadows instead of quieter keyline, underline, or light-blue selected surfaces.
- Radius is inconsistent: `rounded-full`, `rounded-2xl`, and one-off radii appear across controls, cards, menus, and tab bars.
- Buttons, icon buttons, menu items, tags, notices, and inputs are duplicated as local class strings across pages.
- Empty states and error states are mostly serviceable, but visual hierarchy and wording should be normalized around direct "what happened / what to do next" feedback.

## Visual Foundations

### Color Tokens

Keep the existing brand and semantic palette:

- Brand: `#1456F0`
- Brand hover: `#0F4BD8`
- Brand soft: `#F0F5FF`
- Primary text: `#1F2329`
- Icon/default text: `#2B2F36`
- Secondary text: `#646A73`
- Tertiary text: `#8F959E`
- Disabled text: `#BBBFC4`
- Page background: `#F5F6F7`
- Subtle background: `#F8F9FA`
- Divider: `#EFF0F1`
- Border: `#DEE0E3`
- Strong border: `#D0D3D6`
- Success: `#16845B` on `#E4F8EE`
- Warning: `#8B5E00` on `#FFF8DB`
- Danger: `#B42318` on `#FFF1F0`

Rules:

- Brand blue is for primary action, selected navigation, links, focus, and progress.
- Success, warning, and danger colors are reserved for actual state semantics.
- Avoid decorative purple, blue-purple gradient, glass, or tinted ambient backgrounds in the main workbench.
- Main surfaces should be solid or nearly solid white, not translucent by default.

### Typography Tokens

Keep the current restrained typography scale:

- Page title: `20px / 30px`, weight 500.
- Section title: `16px / 24px`, weight 500.
- Body: `14px / 22px`, weight 400.
- Body medium: `14px / 22px`, weight 500.
- Mobile readable body: `16px / 24px`.
- Meta: `12px / 20px`.
- Micro: `11px / 16px`.

Rules:

- Use weights 400 and 500 for most UI. Use 600 sparingly for auth, critical modal titles, or true page-level emphasis.
- Do not use hero-scale type inside app pages, cards, dense panels, or toolbars.
- Keep letter spacing normal.
- Preserve the existing CJK-friendly font stack.

### Radius Tokens

Use a compact set:

- `4px`: code chips, tiny inline markers.
- `6px`: compact tags, small row affordances.
- `8px`: buttons, inputs, menu items, small cards.
- `12px`: panels, cards, popovers, compact sheets.
- `16px`: major dialogs, mobile sheets, large floating layers.
- `999px`: avatars, pills, status badges, icon-only circular controls only.

Rules:

- Avoid one-off radii such as `rounded-[28px]` unless there is a strong platform reason.
- Avoid `rounded-full` for ordinary text buttons and rectangular controls.
- Keep card radius at 8px or 12px unless the component is a true floating mobile sheet.

### Shadow And Layer Tokens

Use shadow to express elevation, not decoration:

- Surface: no shadow or very subtle `0 1px 2px rgba(31,35,41,0.04)`.
- Raised card: `0 4px 12px rgba(31,35,41,0.06)`.
- Floating layer: `0 12px 32px rgba(31,35,41,0.14)`.
- Modal/sheet: `0 18px 48px rgba(31,35,41,0.18)`.

Rules:

- Main page sections should use borders and keylines more than shadows.
- Heavy shadows are only for popovers, dropdowns, modals, mobile sheets, and temporary overlays.
- Blur is only for floating overlays or mobile bottom/sheet treatments where readability remains strong.

### Spacing And Layout Tokens

Use the 4px grid as the mental model:

- 4px: icon/text micro gaps.
- 8px: compact control gaps and menu padding.
- 12px: card internal padding and list spacing.
- 16px: page section padding and mobile touch group padding.
- 24px: major page region separation on desktop.

Rules:

- Desktop rows stay compact: roughly 32-40px for navigation and utility lists.
- Mobile rows preserve touch comfort: roughly 44-52px.
- Page content remains constrained by the existing `WORKBENCH_PAGE_CONTENT_CLASS` pattern.
- Mobile safe-area handling remains unchanged.

### Icon Tokens

Keep lucide-react as the default icon source.

- Compact action icons: 14px, stroke 2.0-2.2.
- Standard toolbar icons: 16px, stroke 2.0-2.2.
- Navigation icons: 16-20px, stroke 2.1-2.25.
- Empty-state icons may use 24-32px, still line-style.

Rules:

- Do not mix icon libraries for normal app chrome.
- Selection should come from text color, background, border, or indicator, not heavier icon strokes.
- Icon buttons must keep `aria-label` and `title` when the icon is not paired with visible text.

## Style Primitive Plan

Update `stylePrimitives.ts` to become the local design-token entrypoint.

Add or rename primitives toward workbench semantics:

- `WORKBENCH_PAGE_BACKGROUND_CLASS`
- `WORKBENCH_SURFACE_CLASS`
- `WORKBENCH_SECTION_CLASS`
- `WORKBENCH_FLOATING_SURFACE_CLASS`
- `WORKBENCH_TOP_BAR_CLASS`
- `WORKBENCH_ICON_BUTTON_CLASS`
- `WORKBENCH_MOBILE_ICON_BUTTON_CLASS`
- `WORKBENCH_PRIMARY_BUTTON_CLASS`
- `WORKBENCH_SECONDARY_BUTTON_CLASS`
- `WORKBENCH_GHOST_BUTTON_CLASS`
- `WORKBENCH_DANGER_BUTTON_CLASS`
- `WORKBENCH_FIELD_CLASS`
- `WORKBENCH_MENU_CLASS`
- `WORKBENCH_MENU_ITEM_CLASS`
- `WORKBENCH_MENU_DANGER_ITEM_CLASS`
- `WORKBENCH_STATUS_*_CLASS`

Backward compatibility aliases can remain temporarily during rollout, but new and touched code should use workbench names rather than `COMPACT_IOS_*` or `GLASS_*`.

## Component System

This pass should not introduce a large component framework. Instead, unify existing local class strings around shared primitives.

### Buttons

- Primary: solid brand blue, used for create/send/save/connect actions.
- Secondary: white background, gray border, dark text.
- Ghost: transparent, subtle hover background.
- Danger: red text or red border; solid red only for destructive confirmation if needed.
- Desktop compact toolbar buttons use 32px height.
- Desktop primary page actions use 36px height.
- Mobile compact secondary actions use 40px height.
- Mobile primary or high-frequency touch actions use 44px height.

### Inputs And Selects

- White background, gray border, 8px radius, 14px desktop text.
- Mobile text should remain 16px to avoid iOS zoom and improve readability.
- Focus uses brand blue border/keyline.
- Error uses danger border plus concise helper text below or inline.

### Tags, Badges, And Status

- Use pill radius.
- Use semantic colors only.
- Text stays 11-12px medium.
- Connected/ready/active states use success; setup/waiting uses warning; failed/disconnected/destructive uses danger or neutral depending on severity.

### Menus And Popovers

- Floating surface with 12px radius, border, moderate shadow.
- Menu items use 8px radius, 32px row height on desktop, 40px on mobile.
- Dangerous items use danger text and light danger hover.
- Menus should not use oversized glass shadows.

### Modals, Drawers, And Sheets

- Desktop modals: centered, white, border, 16px radius, clear header/footer separation.
- Mobile sheets: bottom aligned, safe-area aware, 16px radius at the top, restrained blur/overlay.
- Drawers and inspector-like panels use keylines and solid surfaces rather than glass.

### Navigation

- Top navigation keeps the existing structure: brand/title left, primary navigation center, user/settings right.
- Desktop selected state uses light-blue surface, brand text, and a subtle 2px bottom indicator when the tab sits in a top navigation row. Avoid strong blue filled pills for every active tab.
- Side/session rail selected state should use light-blue background and subtle border, not card-like elevation.
- Mobile bottom tab remains fixed; reduce heavy shadow and one-off radius, but keep touch affordance and safe-area mask.

## Page Application

### Workbench Shell

- Keep desktop top bar, content area, optional inspector, and mobile bottom navigation.
- Use solid page background `#F5F6F7`.
- Inspector edge handles use shared icon/handle primitives and light elevation only.

### ProductTopBar

- Keep logo, Ripple label, centered nav, and settings entry.
- Reduce blur and large pill treatment.
- Align closer to Feishu top navigation: 52px height, bottom keyline, low or no shadow.
- Active tab uses subtle selected treatment instead of a saturated blue pill.

### MobileTabBar

- Keep bottom tab structure and item labels.
- Reduce `rounded-[28px]` and heavy shadow.
- Keep a small floating feel for mobile, but make it calmer: lighter shadow, 16px radius or platform-appropriate pill only if the bar remains visually floating.
- Active item uses brand text and soft icon background, not scale-heavy emphasis.

### WorkspaceNav

- Keep width, collapse behavior, session rows, menus, pin/rename/delete flows.
- Make the rail a solid side surface with right keyline.
- New session button remains primary, but radius and shadow are reduced.
- Session selected row uses light-blue selected background and thin border.
- Menus use shared menu primitives.

### SessionPage And Composer

- Keep the chat workflow and mobile header behavior.
- Normalize header, token badges, warning banners, and empty states.
- Composer keeps strong usability and mobile keyboard handling, but radius/shadow should match workbench tokens.
- Connector auth cards in MarkdownRenderer should use notice/card primitives rather than heavy glass cards.

### Files And WorkspaceExplorer

- Keep page and compact presentations.
- File browser chrome uses solid surfaces and keylines.
- Workspace preview content remains readable and mostly flat.
- Toolbar buttons, context menus, selection bars, create dialogs, confirm dialogs, and preview headers use shared primitives.

### Skills, Connectors, Automations, Settings

- Keep existing page structure.
- Standardize page shell, section cards, primary actions, filter controls, and status tags.
- Connector and skill cards should be dense, white, and scannable.
- Automation form and run history should feel table-like and operational, not card-heavy.
- Settings should use grouped rows and section panels with light borders, not glass cards.

### AuthGateway

AuthGateway can keep slightly stronger brand expression than the main workbench because it is an entry experience. If AuthGateway is touched during this rollout, its typography, button, input, and color styling should use the shared tokens while preserving the existing entry-page structure.

## Interaction And Content Rules

### Feedback

- Loading states use spinner plus concise text where useful.
- Errors state what happened and, when known, what the user can do next.
- Empty states state why the area is empty and offer the most relevant next action.
- Success feedback should be short and should not compete with persistent UI.

### Forms

- Required fields and invalid states should be visually clear.
- Disable submit buttons while saving.
- Keep inline editing behavior for session rename and settings profile fields.
- Preserve keyboard handling for Enter, Escape, and focus behavior.

### Permissions And Connector Auth

- Authorization prompts and connector states should use direct, action-oriented language.
- Destructive connector actions still require explicit confirmation.
- Connected accounts should be easy to scan through avatar/logo, status tag, account label, and action buttons.

### Mobile Gestures

- Preserve current gesture rules:
  - Vertical scroll takes priority.
  - Left-edge back has priority.
  - Non-edge horizontal gestures use higher thresholds.
  - Scroll lock is released when vertical intent becomes clear.
- Android system gesture exclusion behavior remains aligned with mobile back gesture rules.

### Copy

- Use concise tool-style action labels: Save, Create, Cancel, Continue, Delete, Connect, Disconnect, Rename.
- Chinese copy should mirror the same directness: 保存, 创建, 取消, 继续, 删除, 连接, 断开, 重命名.
- Avoid marketing language in app surfaces.
- Keep labels short enough for mobile tabs and buttons.

## Rollout Plan

1. Update shared style primitives and tests.
2. Update shell, top bar, mobile tab bar, and session rail.
3. Update session page, composer, timeline, and Markdown connector cards.
4. Update WorkspaceExplorer and workspace subcomponents.
5. Update Skills, Connectors, Automations, and Settings.
6. Review AuthGateway for token consistency without removing its entry-page polish.
7. Run lint/build and capture desktop/mobile screenshots for visual review.

Each batch should be small enough to verify independently and should avoid unrelated behavior changes.

## Verification

Minimum verification after implementation:

- Run `bun run lint` in `app`.
- Run `bun run build` in `app`.
- Run focused tests that cover touched primitives and page components.
- Inspect desktop and mobile screenshots.

Manual visual checks:

- Web and mobile structure are unchanged.
- Ripple logo is unchanged.
- Main app no longer reads as a glass/iOS utility skin.
- Top navigation, side/session navigation, mobile bottom tabs, cards, menus, forms, tags, badges, modals, and sheets share the same visual language.
- Text fits in buttons, tabs, cards, and mobile controls.
- Mobile safe-area spacing still works for tabs, sheets, composer, and keyboard.
- iOS/Android gesture scenarios remain candidates for true device verification.

## Acceptance Criteria

- Ripple Web and mobile clients use one Feishu/Lark-inspired collaborative workbench design language.
- The existing Web and mobile app structure is preserved.
- The existing Ripple logo and brand assets are preserved.
- Typography, color, icon, spacing, radius, shadow, z-index, and motion choices touched by this rollout are tokenized or routed through shared primitives.
- Primary surfaces use solid workbench surfaces and keylines; glass and strong shadows are limited to true floating layers.
- Core components and repeated class patterns are unified across buttons, inputs, menus, tags, badges, status states, modals/sheets, and navigation.
- Interaction feedback and copy are concise, direct, and tool-oriented.
- Implementation passes the agreed frontend validation commands.
