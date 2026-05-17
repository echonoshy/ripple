import assert from "node:assert/strict";

import { buildChatMessageContent, describeChatFilesForDisplay } from "./chatInput";

const fileRef = {
  path: "/workspace/src/components/TaskComposer.tsx",
  name: "TaskComposer.tsx",
  mime_type: "text/typescript",
  kind: "attachment" as const,
};

function testPlainTextMessagesStayStrings() {
  assert.equal(buildChatMessageContent("  hello Codex  ", []), "hello Codex");
}

function testFilesBecomeOpenAIContentBlocks() {
  assert.deepEqual(buildChatMessageContent("  review this  ", [fileRef]), [
    { type: "text", text: "review this" },
    {
      type: "file",
      file: {
        path: "/workspace/src/components/TaskComposer.tsx",
        name: "TaskComposer.tsx",
        mime_type: "text/typescript",
      },
    },
  ]);
}

function testFileOnlyMessagesAreAllowed() {
  assert.deepEqual(buildChatMessageContent("   ", [fileRef]), [
    {
      type: "file",
      file: {
        path: "/workspace/src/components/TaskComposer.tsx",
        name: "TaskComposer.tsx",
        mime_type: "text/typescript",
      },
    },
  ]);
}

function testDisplayTextIncludesAttachedFiles() {
  assert.equal(
    describeChatFilesForDisplay("Please inspect this", [fileRef]),
    "Please inspect this\n\nAttached files:\n- TaskComposer.tsx (/workspace/src/components/TaskComposer.tsx)"
  );
}

testPlainTextMessagesStayStrings();
testFilesBecomeOpenAIContentBlocks();
testFileOnlyMessagesAreAllowed();
testDisplayTextIncludesAttachedFiles();

console.log("chat input tests passed");
