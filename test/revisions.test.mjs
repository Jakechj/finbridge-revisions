import { test } from "node:test";
import assert from "node:assert/strict";
import { RevisionConflictError, createRevisionStore, pickAsOf, diffValues } from "../src/index.js";

const K = "ACME:2025:FY:consolidated";

function seeded() {
  const s = createRevisionStore();
  s.record({ key: K, revisionId: "r-001", filedDate: "2026-03-10", values: { revenue: 100, net_income: 10 } });
  s.record({ key: K, revisionId: "r-002", filedDate: "2026-05-02", values: { revenue: 100, net_income: 8 } });
  return s;
}

test("a restatement does not overwrite the original revision", () => {
  const s = seeded();
  const h = s.history(K);
  assert.equal(h.length, 2);
  assert.equal(h[0].values.net_income, 10);
  assert.equal(h[1].values.net_income, 8);
  assert.equal(s.latest(K).revisionId, "r-002");
  assert.equal(s.isRestated(K), true);
});

test("asOf returns only what was public on that date", () => {
  const s = seeded();
  assert.equal(s.asOf(K, "2026-03-09"), null);
  assert.equal(s.asOf(K, "2026-03-10").revisionId, "r-001"); // inclusive
  assert.equal(s.asOf(K, "2026-05-01").values.net_income, 10);
  assert.equal(s.asOf(K, "2026-05-02").values.net_income, 8);
  assert.equal(s.asOf("missing", "2030-01-01"), null);
});

test("first disclosure date does not move when a restatement arrives", () => {
  const s = seeded();
  assert.equal(s.firstDisclosed(K), "2026-03-10");
  s.record({ key: K, revisionId: "r-003", filedDate: "2026-09-01", values: { revenue: 99, net_income: 8 } });
  assert.equal(s.firstDisclosed(K), "2026-03-10");
});

test("re-recording the same revision id is idempotent and keeps the earlier filed date", () => {
  const s = seeded();
  s.record({ key: K, revisionId: "r-001", filedDate: "2026-04-20", values: { revenue: 100, net_income: 10 } });
  assert.equal(s.history(K).length, 2);
  assert.equal(s.history(K)[0].filedDate, "2026-03-10");
});

test("re-recording a revision id with different values is refused and leaves past reads unchanged", () => {
  const s = createRevisionStore();
  s.record({ key: K, revisionId: "r1", filedDate: "2026-03-10", values: { v: 10 } });
  assert.throws(() => s.record({ key: K, revisionId: "r1", filedDate: "2026-06-01", values: { v: 999 } }), RevisionConflictError);
  assert.equal(s.asOf(K, "2026-04-01").values.v, 10);
  assert.equal(s.history(K).length, 1);
  // same values in a different key order is the same revision
  s.record({ key: K, revisionId: "r2", filedDate: "2026-05-01", values: { a: 1, b: { c: 2 } } });
  assert.doesNotThrow(() => s.record({ key: K, revisionId: "r2", filedDate: "2026-05-02", values: { b: { c: 2 }, a: 1 } }));
  assert.equal(s.history(K).at(-1).filedDate, "2026-05-01");
});

test("same-day revisions resolve by insertion order", () => {
  const s = createRevisionStore();
  s.record({ key: K, revisionId: "b", filedDate: "2026-01-05", values: { x: 1 } });
  s.record({ key: K, revisionId: "a", filedDate: "2026-01-05", values: { x: 2 } });
  assert.equal(s.latest(K).revisionId, "a");
  assert.equal(s.asOf(K, "2026-01-05").values.x, 2);
});

test("out-of-order ingestion still yields a time-ordered history", () => {
  const s = createRevisionStore();
  s.record({ key: K, revisionId: "late", filedDate: "2026-06-01", values: { x: 2 } });
  s.record({ key: K, revisionId: "early", filedDate: "2026-02-01", values: { x: 1 } });
  assert.deepEqual(s.history(K).map((r) => r.revisionId), ["early", "late"]);
  assert.equal(s.firstDisclosed(K), "2026-02-01");
});

test("changes lists field-level differences between consecutive revisions", () => {
  const s = seeded();
  assert.deepEqual(s.changes(K), [
    { from: "r-001", to: "r-002", filedDate: "2026-05-02", changes: [{ field: "net_income", before: 10, after: 8 }] },
  ]);
});

test("snapshot gives every key as of a date and skips unpublished keys", () => {
  const s = seeded();
  s.record({ key: "OTHER:2025:FY", revisionId: "o-1", filedDate: "2026-04-01", values: { revenue: 5 } });
  const snap = s.snapshot("2026-03-31");
  assert.deepEqual([...snap.keys()], [K]);
  assert.equal(snap.get(K).values.net_income, 10);
  assert.equal(s.snapshot("2026-12-31").size, 2);
});

test("stored revisions are immutable", () => {
  const s = seeded();
  const r = s.latest(K);
  assert.throws(() => {
    "use strict";
    r.values.net_income = 999;
  }, TypeError);
  assert.equal(s.latest(K).values.net_income, 8);
});

test("caller mutations after record() do not leak into the store", () => {
  const s = createRevisionStore();
  const values = { x: 1 };
  s.record({ key: K, revisionId: "a", filedDate: "2026-01-01", values });
  values.x = 2;
  assert.equal(s.latest(K).values.x, 1);
});

test("toJSON round-trips", () => {
  const s = seeded();
  const restored = createRevisionStore(JSON.parse(JSON.stringify(s.toJSON())));
  assert.deepEqual(restored.history(K).map((r) => [r.revisionId, r.filedDate, r.values]), s.history(K).map((r) => [r.revisionId, r.filedDate, r.values]));
  assert.equal(restored.firstDisclosed(K), "2026-03-10");
});

test("input validation", () => {
  const s = createRevisionStore();
  assert.throws(() => s.record({ key: "", revisionId: "a", filedDate: "2026-01-01", values: {} }), TypeError);
  assert.throws(() => s.record({ key: K, revisionId: "", filedDate: "2026-01-01", values: {} }), TypeError);
  assert.throws(() => s.record({ key: K, revisionId: "a", filedDate: "2026/01/01", values: {} }), TypeError);
  assert.throws(() => s.record({ key: K, revisionId: "a", filedDate: "2026-13-45", values: {} }), TypeError);
  for (const bad of ["2026-02-31", "2026-04-31", "2025-02-29", "0000-01-01"]) {
    assert.throws(() => s.record({ key: K, revisionId: "a", filedDate: bad, values: {} }), TypeError, bad);
  }
  assert.doesNotThrow(() => s.record({ key: K, revisionId: "leap", filedDate: "2024-02-29", values: {} }));
  assert.throws(() => s.record({ key: K, revisionId: "a", filedDate: "2026-01-01", values: new Map() }), TypeError);
  assert.throws(() => s.record({ key: K, revisionId: "a", filedDate: null, values: {} }), TypeError);
  assert.throws(() => s.record({ key: K, revisionId: "a", filedDate: "2026-01-01", values: [] }), TypeError);
  assert.throws(() => s.asOf(K, "yesterday"), TypeError);
});

test("pickAsOf works on plain arrays from any storage", () => {
  const rows = [
    { filedDate: "2026-05-02", net_income: 8 },
    { filedDate: "2026-03-10", net_income: 10 },
  ];
  assert.equal(pickAsOf(rows, "2026-04-01").net_income, 10);
  assert.equal(pickAsOf(rows, "2026-05-02").net_income, 8);
  assert.equal(pickAsOf(rows, "2026-01-01"), null);
});

test("diffValues handles added, removed and NaN fields", () => {
  assert.deepEqual(diffValues({ a: 1, b: NaN, c: 3 }, { a: 1, b: NaN, d: 4 }), [
    { field: "c", before: 3, after: undefined },
    { field: "d", before: undefined, after: 4 },
  ]);
});
