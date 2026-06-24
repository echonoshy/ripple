import assert from "node:assert/strict";

import {
  CLIENT_CONTEXT_FIXTURES,
  CONTEXT_EXPLAINER_REQUIRED_SKILL_ID,
  getClientContextFixture,
} from "./clientContextFixtures";

function testFixturesIncludeHostAppAndHeadsetContext() {
  const fixture = getClientContextFixture("meeting-detail-with-headset");

  assert.equal(fixture?.requiredSkillIds?.[0], CONTEXT_EXPLAINER_REQUIRED_SKILL_ID);
  assert.equal(fixture?.clientContext?.schema_version, "ripple.client_context.v1");
  assert.equal(fixture?.clientContext?.software?.host_app?.app_id, "viaim.meeting");
  assert.equal(fixture?.clientContext?.software?.screen?.screen_id, "meeting.detail");
  assert.equal(fixture?.clientContext?.devices?.[0]?.kind, "ai_headset");
  assert.equal(fixture?.clientContext?.devices?.[0]?.state?.noise_control, "anc");
}

function testNoneFixtureClearsContext() {
  const fixture = getClientContextFixture("none");

  assert.equal(fixture?.clientContext, null);
  assert.equal(fixture?.requiredSkillIds, undefined);
}

function testFixtureIdsStayUnique() {
  const ids = CLIENT_CONTEXT_FIXTURES.map((fixture) => fixture.id);

  assert.equal(new Set(ids).size, ids.length);
}

testFixturesIncludeHostAppAndHeadsetContext();
testNoneFixtureClearsContext();
testFixtureIdsStayUnique();

console.log("client context fixture tests passed");
