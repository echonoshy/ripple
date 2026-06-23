# Ripple Screenshot Visual Recognition

Use this before explaining a screenshot target when the user marks a button with a red box, asks about an icon-only control, or the same icon appears in multiple places.

## Core Rule

Do not identify a control by icon alone. Classify the visible region first, then confirm the target with nearby labels, adjacent controls, active page, visual state, and any known data anchors in the page references.

## Recognition Order

1. Locate the page: Sessions, Tasks, Files, Skills, Settings, modal, sheet, or inspector.
2. Locate the region: top navigation, page toolbar, header/status area, timeline, composer toolbar, file preview, task detail, card/list row, modal, or mobile bottom tab.
3. Use neighbors: buttons immediately left/right, input placeholder, row title, section heading, chip text, selected tab, and whether the target is inside the bottom composer.
4. Match the detailed reference only after the region is known.
5. Explain the click result from the matched reference, then say whether it navigates, opens a menu/sheet, starts execution, changes stored state, uploads, or requires confirmation.

## Common Visual Collisions

| Visual clue | Correct reading | Do not say |
| --- | --- | --- |
| BrainCircuit in the bottom composer toolbar, near folder/paperclip/input/send | Composer model selector. It opens the model menu. | Create skill, Skills page, skill picker, workflow selector |
| BrainCircuit in the session header with Lite/Plus/Pro/Ultra text or status dot | Header current-model badge. It is display/status, not the dropdown. | Model menu button unless the screenshot also shows the composer control |
| Sparkles/ability icon in the top navigation with `能力` / Skills label | Top Skills tab. It navigates to the Skills page. | Composer model selector |
| Folder icon in the composer toolbar before paperclip | Work folder selector for the chat context. | Attach/upload file |
| Paperclip icon in the composer toolbar | Attach local files to the draft. | Work folder selector or workspace browser |
| Plus/Run/Confirm inside Tasks detail | Task/action/trigger operation; check exact label and status. | Generic add button or harmless navigation |
| More/ellipsis on a file row or preview | Entry action menu for that file/location. | Global app settings |

Use `chat-session.md` and `model-selection.md` for the BrainCircuit cases. Use `navigation.md` and `skills-connectors.md` for the top Skills tab.

## Composer BrainCircuit Checklist

Treat a BrainCircuit-like icon as the model selector only when the screenshot shows these clues:

- It is in the bottom composer toolbar.
- It is adjacent to composer controls such as work folder, paperclip, text input, or send.
- The surrounding UI is a Sessions/chat page.
- The known code anchor is `data-ripple-composer-model-button`.

Click result: opens `data-ripple-composer-model-menu`; choosing Lite/Plus/Pro/Ultra changes the selected model preset for the next response and remembers the default preference. It does not send the message and does not open the Skills page.

Treat the same icon as the header current-model badge when it appears near the session title/header with the current model label. That badge is informational in the current code.

Treat the top `能力` / Skills tab as navigation to Skills. It is not a model control.

## Ambiguity Handling

If the screenshot target is ambiguous, do not collapse multiple possible controls into one confident answer. Say which target you think the user means and which visual clue led you there. If two controls are plausible, answer both briefly or ask for clarification.

Good pattern:

- "红框看起来是在底部输入框左侧的 composer toolbar 里，紧挨着附件按钮，所以这是选择模型按钮。点击会打开 Lite/Plus/Pro/Ultra 的模型菜单。"
- "如果你指的是顶部的 `能力` 标签，那是页面导航；但如果你指的是底部输入框旁边的脑形图标，那是模型选择。"

Bad pattern:

- "这是 Create skill."
- "这是一个通用能力按钮，点击后会选择技能."
- "脑图标一般代表 AI，所以会启动智能能力."

## Answer Checklist

For a screenshot-based button answer, include:

- Target: identify the likely target and region.
- Click result: menu, sheet, navigation, upload, execution, state change, or confirmation.
- Persistence/risk: whether anything is saved, started, uploaded, or deleted.
- Uncertainty: only if the screenshot does not provide enough visual evidence.
