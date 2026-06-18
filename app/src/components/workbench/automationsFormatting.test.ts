import assert from "node:assert/strict";
import type { AgentRunInfo, ScheduleInfo } from "@/types";
import {
  datetimeInputValue,
  formatDate,
  hasRunOutput,
  intervalLabel,
  intervalParts,
  runCountLabel,
  runErrorText,
  timezoneOptions,
} from "./automationsFormatting";

const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

function testRunOutputAndErrors() {
  const completedRun = {
    status: "completed",
    output_available: true,
    stderr_tail: "tool warning",
  } as AgentRunInfo;
  const runningRun = { status: "running", output_available: true } as AgentRunInfo;
  const failedRun = {
    status: "failed",
    output_available: true,
    stderr_tail: "\u001b[31m failed \u001b[0m\n",
  } as AgentRunInfo;

  assert.equal(hasRunOutput(completedRun), true);
  assert.equal(hasRunOutput(runningRun), false);
  assert.equal(runErrorText(completedRun), null);
  assert.equal(runErrorText(failedRun), "failed");
}

function testScheduleLabels() {
  assert.equal(intervalLabel(3600, t), 'automations.intervalEvery:{"value":1,"unit":"h"}');
  assert.deepEqual(intervalParts(86_400), { value: 1, unit: "days" });
  assert.equal(
    runCountLabel({ kind: "interval", run_count: 2, max_runs: 5 } as ScheduleInfo, t),
    'automations.runsProgress:{"count":2,"max":5}'
  );
}

function testTimeInputs() {
  assert.equal(datetimeInputValue("2026-06-18T10:20:30Z"), "2026-06-18T10:20");
  assert.equal(formatDate(null, "en-US", t), "automations.notScheduled");
  assert.ok(timezoneOptions("Asia/Shanghai").includes("Asia/Shanghai"));
}

testRunOutputAndErrors();
testScheduleLabels();
testTimeInputs();

console.log("automations formatting tests passed");
