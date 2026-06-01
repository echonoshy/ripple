# Compact iOS Glass Style Unification

## Context

Ripple's web client and Tauri mobile shells share the same Vite + React app. The current UI is already broadly consistent: it uses lucide icons, light surfaces, gray-blue borders, and blue as the primary accent. The main inconsistency is stylistic weight. Mobile screens use translucent glass surfaces, blur, soft shadows, and card-like dense lists, while parts of the desktop shell and compact workspace panels remain flatter and more console-like.

This work intentionally focuses on visual unification only. Broader product structure and console/workbench information architecture will be discussed separately.

## Direction

Unify the app around a compact iOS glass style:

- Light blue-white app backgrounds with very subtle blue/purple radial light.
- Translucent panels using `bg-white/70` to `bg-white/82`, `backdrop-blur-xl` or `backdrop-blur-2xl`, one-pixel gray-blue borders, and restrained shadows.
- Dense utility layout rather than large marketing cards.
- Lucide line icons with consistent visual weight.
- Mobile-inspired tactile surfaces, adapted to higher desktop information density.

The target should feel closer to iOS Settings, Files, and compact native utility panels than to a landing page or a decorative dashboard.

## Non-Goals

- Do not change backend behavior or API integration.
- Do not redesign the control-plane/workbench structure in this pass.
- Do not introduce a new frontend framework or heavy component library.
- Do not add decorative illustrations, large hero areas, or marketing-style page composition.
- Do not loosen information density to achieve glass effects.

## Visual Tokens

### Backgrounds

Use one shared page background family for the main tabs:

```text
radial-gradient(circle_at_16%_0%, rgba(47,107,255,0.10-0.12), transparent_34%),
radial-gradient(circle_at_88%_8%, rgba(139,92,246,0.08-0.11), transparent_32%),
#fbfdff
```

Settings should use the same blue/purple family instead of a separate teal accent background. Teal and green remain reserved for success states.

### Surfaces

Default glass surfaces:

- Background: `bg-white/70` to `bg-white/82`
- Border: `border border-[#dfe6f4]`
- Secondary divider: `border-[#e8edf7]`
- Blur: `backdrop-blur-xl` for local controls, `backdrop-blur-2xl` for headers, sheets, and bottom navigation
- Shadow: restrained blue-gray shadows such as `0 8px 22px rgba(44,63,123,0.05)` or `0 12px 30px rgba(44,63,123,0.06)`

Avoid mixing fully flat white panels with heavy glass panels on the same screen unless the flat panel is an intentional document/editor surface.

### Borders and Lines

- Default borders stay one pixel.
- Focus rings and drag/drop rings may use two pixels.
- Avoid three- or four-pixel selection bars in navigation and lists. Prefer a soft selected background, accent border, or small status marker.
- Markdown blockquotes and code can keep their existing stronger local treatment because they are content semantics rather than app chrome.

### Radius

Use a small set of radius levels:

- Small controls and menu items: `rounded-lg`
- Cards, menus, inputs, and compact panels: `rounded-xl`
- Sheets, major popovers, and large mobile panels: `rounded-2xl`
- Pills and icon-only circular controls: `rounded-full`

Reduce ad hoc `rounded-[20px]`, `rounded-[22px]`, and similar one-off radii unless a container is a true bottom sheet or full-window file surface.

### Icons

Keep lucide-react as the default icon source.

- Standard icon buttons: size `13` to `15`, stroke width `2.1` or `2.2`
- Primary navigation icons: size `15`, stroke width `2.25`
- Composer tool icons: size `16`, stroke width `2.1` or `2.2`
- Avoid selected-state stroke weights above `2.25`; selected state should come from color, surface, or shadow rather than heavier line art.

The existing `IconTile` remains the central icon badge primitive, but its radius and usage should follow the compact radius rules.

## Density Rules

The style should become more compact, not airier.

- Desktop top bars: about `48px` to `52px`.
- Mobile top bars: about `52px` to `56px`, plus safe-area padding.
- Desktop rows: about `34px` to `40px` for navigation and utility lists.
- Mobile list rows: about `44px` to `52px`, preserving touch ergonomics.
- Primary content card padding: prefer `p-2.5` or `p-3`; reserve `p-4` for forms or large editing areas.
- Section gaps: prefer `space-y-2` or `space-y-3`; use larger gaps only between major page regions.
- Text hierarchy: main utility text `13px` to `14px`, section labels `11px` to `12px`, metadata `10px` to `11px`.

## Component Scope

### Shared Style Primitives

Create or consolidate small local primitives before broad page edits:

- Glass page shell class or helper for tab page backgrounds and safe-area padding.
- Glass panel class/helper for `bg-white/70-82 + border + blur + shadow`.
- Dense icon button class/helper for `h-8/h-9`, lucide icon sizing, border, and hover state.
- Primary action treatment that can be either solid blue or a restrained blue-purple gradient, used consistently.
- Menu container and menu item classes for all dropdowns, popovers, and context menus.

These can start as class string helpers inside existing components or a small shared UI utility module. Do not build a large design-system abstraction before it earns its keep.

### Shell and Navigation

Apply the mobile glass language to the desktop shell without reducing density:

- Desktop sidebar should use the same translucent surface vocabulary as mobile.
- Mobile tab bar remains the reference for glass treatment, but reduce any excessive selected icon stroke weight.
- Collapsed sidebar and inspector buttons should match the same dense glass icon-button treatment.
- Navigation selection should use accent surface and border, not heavier text or oversized shadow.

### Session and Composer

Session is the highest-frequency surface and should be unified early:

- Keep the translucent top bars and composer container.
- Normalize composer radius from one-off large values to the shared sheet/panel radius scale.
- Keep icon buttons compact and consistent across desktop and mobile.
- Replace loud gradient usage in utility panels with quieter blue treatments where the action is not a primary creation/send action.

### Files and Workspace Explorer

WorkspaceExplorer currently has the largest split between compact and page presentation. It should be the main convergence target after shell/session:

- Keep the page mode glass frame, but reduce oversized one-off radii.
- Bring compact inspector mode closer to the same token set, while preserving its denser sidebar role.
- Normalize toolbar buttons, context menus, preview headers, and file rows across both presentations.
- Keep document/editor preview surfaces clean and mostly flat so file content stays readable.

### Settings, Connectors, and Automations

These should inherit the shared page shell and glass panel treatment:

- Settings should use the shared blue/purple background family.
- Connectors and Automations cards should keep dense information blocks but use the same panel, menu, and button primitives.
- Automation run history can stay table-like/dense; avoid making it visually heavier than session or files.

## Rollout Plan

1. Establish shared visual constants/classes and normalize icon stroke conventions.
2. Update Shell, WorkspaceNav, MobileTabBar, and global page backgrounds.
3. Update SessionPage and SessionComposer.
4. Update WorkspaceExplorer in both page and compact presentations.
5. Update SettingsPage, ConnectorsPage, and AutomationsPage.
6. Do a visual pass for menus, popovers, action buttons, and empty states.

Each step should be small enough to review with focused screenshots and component tests where existing tests already lock visual class choices.

## Verification

For each implementation batch:

- Run `bun run lint` in `app` when practical.
- Run `bun run build` in `app` before considering the visual pass complete.
- Use desktop, narrow desktop, and mobile viewport screenshots.
- Check that text does not overflow buttons, headers, cards, or bottom navigation labels.
- Check mobile safe-area spacing for bottom navigation, composer, and sheets.
- Check that glass surfaces remain readable over the page gradient.

## Acceptance Criteria

- The main app tabs share one compact iOS glass visual language.
- Desktop no longer feels like a separate flat console skin, while still preserving higher information density.
- Mobile remains touch-friendly but becomes slightly tighter where possible.
- Border, radius, shadow, and icon stroke rules are consistent across shell, session, files, settings, connectors, and automations.
- No backend behavior, routing contract, connector flow, or session data flow changes as part of the visual pass.
