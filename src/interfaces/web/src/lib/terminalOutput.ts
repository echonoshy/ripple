export const TERMINAL_OUTPUT_PREVIEW_LIMIT = 4_000;

export interface TerminalOutputPreview {
  text: string;
  isTruncated: boolean;
  hiddenChars: number;
}

export function formatTerminalOutputPreview(
  output: string,
  limit = TERMINAL_OUTPUT_PREVIEW_LIMIT
): TerminalOutputPreview {
  if (output.length <= limit) {
    return {
      text: output,
      isTruncated: false,
      hiddenChars: 0,
    };
  }

  return {
    text: output.slice(0, limit),
    isTruncated: true,
    hiddenChars: output.length - limit,
  };
}
