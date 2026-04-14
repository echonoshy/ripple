export function shouldApplyInputFocus(focusToken: number, isGenerating: boolean): boolean {
  return focusToken > 0 && !isGenerating;
}

export function bumpInputFocusToken(currentToken: number): number {
  return currentToken + 1;
}
