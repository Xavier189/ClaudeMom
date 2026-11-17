import assert from "node:assert/strict";
import test from "node:test";
import { formatOverlapSection, parseSyncArgs } from "./sync-upstream.mjs";

test("parseSyncArgs handles supported flags and rejects unknown flags", () => {
  assert.deepEqual(parseSyncArgs(["--dry-run", "--force-resync"]), {
    dryRun: true,
    forceResync: true,
    help: false,
  });
  assert.throws(() => parseSyncArgs(["--unknown"]), /未知参数/);
});

test("formatOverlapSection highlights overlapping hot customized files", () => {
  assert.match(formatOverlapSection([]), /未直接修改核心个人定制文件/);
  const warn = formatOverlapSection(["crates/claude-local/runtime/proxy.mjs"]);
  assert.match(warn, /个人定制高敏感文件重叠提醒/);
  assert.match(warn, /proxy\.mjs/);
});
