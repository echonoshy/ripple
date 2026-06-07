import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Trash2 } from "lucide-react";

import MobileActionSheet from "./MobileActionSheet";

function testMobileActionSheetRendersBottomSafeAreaPanel() {
  const html = renderToStaticMarkup(
    <MobileActionSheet
      open
      title="More actions"
      subtitle="workspace"
      closeLabel="Cancel"
      onClose={() => {}}
      actions={[
        { key: "copy", label: "Copy", onClick: () => {} },
        {
          key: "delete",
          label: "Delete",
          icon: <Trash2 size={16} />,
          tone: "danger",
          onClick: () => {},
        },
      ]}
    />
  );

  assert.match(html, /data-ripple-mobile-action-sheet="true"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, />More actions</);
  assert.match(html, />workspace</);
  assert.match(html, /pb-\[max\(env\(safe-area-inset-bottom\),8px\)\]/);
  assert.match(html, /data-ripple-mobile-action-sheet-action="delete"/);
  assert.match(html, /text-\[#B42318\]/);
  assert.match(html, />Cancel</);
}

function testMobileActionSheetDoesNotRenderWhenClosed() {
  const html = renderToStaticMarkup(
    <MobileActionSheet open={false} title="Hidden" onClose={() => {}} actions={[]} />
  );

  assert.equal(html, "");
}

testMobileActionSheetRendersBottomSafeAreaPanel();
testMobileActionSheetDoesNotRenderWhenClosed();

console.log("mobile action sheet tests passed");
