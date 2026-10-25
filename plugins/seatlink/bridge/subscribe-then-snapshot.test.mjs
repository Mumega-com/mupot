import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOPOLOGY_SUBSCRIPTIONS,
  SUBSCRIBE_THEN_SNAPSHOT_STEPS,
  buildSubscriptions,
} from "./seatlink.mjs";

test("0.9 order is subscribe topology, snapshot, then per-pane subscribe", () => {
  assert.deepEqual([...SUBSCRIBE_THEN_SNAPSHOT_STEPS], [
    "subscribe_topology",
    "snapshot_agent_list",
    "subscribe_per_pane",
  ]);
});

test("topology subscriptions have no pane_id", () => {
  assert.ok(TOPOLOGY_SUBSCRIPTIONS.length >= 3);
  for (const s of TOPOLOGY_SUBSCRIPTIONS) {
    assert.equal(s.pane_id, undefined);
    assert.match(s.type, /^pane\.(created|closed|exited)$/);
  }
});

test("buildSubscriptions puts topology first then per-pane ids from the snapshot", () => {
  const map = { list: [{ pane_id: "wJ:p6" }, { pane_id: "wG:p2" }] };
  const subs = buildSubscriptions(map);
  const topo = subs.filter((s) => !s.pane_id);
  const perPane = subs.filter((s) => s.pane_id);
  assert.deepEqual(topo.map((s) => s.type), TOPOLOGY_SUBSCRIPTIONS.map((s) => s.type));
  assert.equal(subs[0].type, "pane.created");
  assert.ok(perPane.every((s) => s.pane_id === "wJ:p6" || s.pane_id === "wG:p2"));
  const status = perPane.filter((s) => s.type === "pane.agent_status_changed");
  assert.equal(status.length, 2);
  const matched = perPane.filter((s) => s.type === "pane.output_matched");
  assert.equal(matched.length, 4);
  assert.ok(matched.every((s) => s.match?.type === "regex"));
});

test("serve source still subscribe-then-snapshot (no snapshot-first)", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./seatlink.mjs", import.meta.url), "utf8"),
  );
  const serveIdx = src.indexOf("async function serve(");
  const snapIdx = src.indexOf("map = await seatMap()", serveIdx);
  const topoIdx = src.indexOf("subscribe([...TOPOLOGY_SUBSCRIPTIONS]", serveIdx);
  assert.ok(serveIdx >= 0 && snapIdx > serveIdx && topoIdx > serveIdx);
  assert.ok(topoIdx < snapIdx, "topology subscribe must run before agent.list snapshot");
  const fullIdx = src.indexOf("subscribe(full, handler", serveIdx);
  assert.ok(fullIdx > snapIdx, "per-pane subscribe must run after snapshot");
  assert.doesNotMatch(src, /Subscribe RESCANS the current snapshot/);
  assert.match(src, /reconcileBeforeDeliver/);
  assert.match(src, /byLabel/);
});
