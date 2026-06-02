import assert from "node:assert/strict";

import { getUserProfileAvatarUri, USER_AVATAR_CHANGED_EVENT } from "./userAvatar";

function testPrefersNestedProfileAvatarUri() {
  assert.equal(
    getUserProfileAvatarUri({
      user_id: "lake",
      avatar_uri: "/outer.png",
      profile: { avatar_uri: "/nested.png" },
    }),
    "/nested.png"
  );
}

function testFallsBackToTopLevelAvatarUri() {
  assert.equal(
    getUserProfileAvatarUri({ user_id: "lake", avatar_uri: "/outer.png" }),
    "/outer.png"
  );
}

function testReturnsNullWithoutAvatar() {
  assert.equal(getUserProfileAvatarUri({ user_id: "lake", avatar_uri: null }), null);
  assert.equal(getUserProfileAvatarUri(null), null);
}

function testAvatarChangedEventNameIsStable() {
  assert.equal(USER_AVATAR_CHANGED_EVENT, "ripple:user-avatar-changed");
}

testPrefersNestedProfileAvatarUri();
testFallsBackToTopLevelAvatarUri();
testReturnsNullWithoutAvatar();
testAvatarChangedEventNameIsStable();

console.log("user avatar tests passed");
