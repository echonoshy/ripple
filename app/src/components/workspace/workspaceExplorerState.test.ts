import assert from "node:assert/strict";

import type { WorkspaceListing } from "@/types";
import {
  WORKSPACE_DRAG_ENTRY_MIME,
  getCachedWorkspaceLastPath,
  getCachedWorkspaceListing,
  getWorkspaceDragPaths,
  hasDraggedWorkspaceEntries,
  setCachedWorkspaceLastPath,
  setCachedWorkspaceListing,
  setWorkspaceDragPaths,
} from "./workspaceExplorerState";

class FakeDataTransfer {
  private data = new Map<string, string>();

  get types(): string[] {
    return [...this.data.keys()];
  }

  getData(type: string): string {
    return this.data.get(type) || "";
  }

  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
}

function testWorkspaceCacheUsesUserAndPathBoundary() {
  const listing: WorkspaceListing = {
    path: "/workspace/a",
    parent_path: "/workspace",
    entries: [],
  };

  setCachedWorkspaceListing("alice", listing);
  setCachedWorkspaceLastPath("alice", listing.path);

  assert.equal(getCachedWorkspaceListing("alice", "/workspace/a"), listing);
  assert.equal(getCachedWorkspaceLastPath("alice"), "/workspace/a");
  assert.equal(getCachedWorkspaceListing("bob", "/workspace/a"), null);
  assert.equal(getCachedWorkspaceLastPath("bob"), null);
}

function testWorkspaceDragPayloadRoundTripsSelectedPaths() {
  const dataTransfer = new FakeDataTransfer() as unknown as DataTransfer;

  setWorkspaceDragPaths(dataTransfer, ["/workspace/a.txt", "/workspace/b.txt"]);

  assert.equal(hasDraggedWorkspaceEntries({ dataTransfer }), true);
  assert.deepEqual(getWorkspaceDragPaths(dataTransfer), ["/workspace/a.txt", "/workspace/b.txt"]);
  assert.equal(dataTransfer.getData("text/plain"), "/workspace/a.txt\n/workspace/b.txt");
  assert.match(WORKSPACE_DRAG_ENTRY_MIME, /ripple-workspace-entry/);
}

function testWorkspaceDragPayloadIgnoresInvalidData() {
  const dataTransfer = new FakeDataTransfer() as unknown as DataTransfer;
  dataTransfer.setData(WORKSPACE_DRAG_ENTRY_MIME, "{broken");

  assert.deepEqual(getWorkspaceDragPaths(dataTransfer), []);
}

testWorkspaceCacheUsesUserAndPathBoundary();
testWorkspaceDragPayloadRoundTripsSelectedPaths();
testWorkspaceDragPayloadIgnoresInvalidData();

console.log("workspace explorer state tests passed");
