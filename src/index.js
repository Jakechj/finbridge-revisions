/**
 * finbridge-revisions — append-only, point-in-time revision history for
 * restated records (financial statements, filings, any value that can be
 * corrected after it was first published).
 *
 * Rules the store enforces:
 *   1. A revision is never overwritten by a different revision. A correction
 *      is a new revision with its own id, so the original stays readable.
 *   2. Every revision carries the date it became public (`filedDate`).
 *      `asOf(key, T)` only sees revisions with `filedDate <= T`, so a
 *      backtest at time T cannot read numbers published after T.
 *   3. The first disclosure date of a key never moves when a restatement
 *      arrives. Treating a restated number as if it was known on the
 *      original date is look-ahead bias.
 *
 * Zero runtime dependencies. Plain ESM with JSDoc types.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {Record<string, unknown>} Values
 *
 * @typedef {object} RevisionInput
 * @property {string} key          Identity of the record being revised, e.g. "ACME:2025:Q4:consolidated".
 * @property {string} revisionId   Id of the document that produced these values (filing / receipt number).
 *                                 Re-recording the same id updates that revision in place (idempotent re-ingest).
 * @property {string} filedDate    Date the document became public, "YYYY-MM-DD".
 * @property {Values} values       The figures as published in that document.
 *
 * @typedef {object} Revision
 * @property {string} key
 * @property {string} revisionId
 * @property {string} filedDate
 * @property {Readonly<Values>} values
 * @property {number} seq          Insertion order; breaks ties between revisions filed on the same date.
 *
 * @typedef {object} Change
 * @property {string} field
 * @property {unknown} before
 * @property {unknown} after
 */

/** @param {unknown} d @param {string} name */
function assertDate(d, name) {
  if (typeof d !== "string" || !DATE_RE.test(d) || !isCalendarDate(d)) {
    throw new TypeError(`${name} must be a real "YYYY-MM-DD" date, got ${JSON.stringify(d)}`);
  }
}

/** Rejects dates that Date.parse silently rolls over (2026-02-31 -> 2026-03-03). @param {string} d */
function isCalendarDate(d) {
  const [y, m, day] = d.split("-").map(Number);
  if (y < 1000) return false;
  const t = new Date(Date.UTC(y, m - 1, day));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
}

/** Stable JSON text of a values object, for comparing re-recorded revisions. @param {unknown} v @returns {string} */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(/** @type {any} */ (v)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

/** Thrown when a (key, revisionId) is recorded again with different values. */
export class RevisionConflictError extends Error {
  /** @param {string} key @param {string} revisionId */
  constructor(key, revisionId) {
    super(`revision ${JSON.stringify(revisionId)} of ${JSON.stringify(key)} already exists with different values; record a correction under its own revisionId`);
    this.name = "RevisionConflictError";
    this.key = key;
    this.revisionId = revisionId;
  }
}

/** Order: filedDate ascending, then insertion order. @param {Revision} a @param {Revision} b */
function byFiled(a, b) {
  return a.filedDate < b.filedDate ? -1 : a.filedDate > b.filedDate ? 1 : a.seq - b.seq;
}

/**
 * Pure helper for callers that keep revisions in their own storage:
 * returns the revision that was current on `date`, or null if none was public yet.
 * @template {{ filedDate: string }} R
 * @param {readonly R[]} revisions  Revisions of one key, any order.
 * @param {string} date             "YYYY-MM-DD", inclusive.
 * @returns {R | null}
 */
export function pickAsOf(revisions, date) {
  assertDate(date, "date");
  /** @type {R | null} */
  let best = null;
  for (const r of revisions) {
    if (r.filedDate <= date && (best === null || r.filedDate >= best.filedDate)) best = r;
  }
  return best;
}

/**
 * Field-level differences between two value objects (shallow, `Object.is`).
 * @param {Values} before
 * @param {Values} after
 * @returns {Change[]}
 */
export function diffValues(before, after) {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  /** @type {Change[]} */
  const out = [];
  for (const field of [...fields].sort()) {
    if (!Object.is(before[field], after[field])) out.push({ field, before: before[field], after: after[field] });
  }
  return out;
}

/**
 * In-memory revision store. Persist it with `toJSON()` / `createRevisionStore(json)`,
 * or mirror the same rules in your database (see README, "Using your own database").
 * @param {{ revisions?: RevisionInput[] }} [init]
 */
export function createRevisionStore(init) {
  /** @type {Map<string, Map<string, Revision>>} */
  const byKey = new Map();
  let seq = 0;

  /** @param {string} key @returns {Revision[]} */
  function sorted(key) {
    const m = byKey.get(key);
    return m ? [...m.values()].sort(byFiled) : [];
  }

  const store = {
    /**
     * Add a revision. Recording an existing (key, revisionId) again is allowed only
     * with the same values (a re-download); it keeps the earlier of the two
     * filedDates, so a late re-download cannot push a disclosure date later.
     * Different values throw RevisionConflictError: a stored revision is never
     * overwritten, because that would change what past asOf() reads return.
     * @param {RevisionInput} input
     * @returns {Revision}
     */
    record(input) {
      if (!input || typeof input !== "object") throw new TypeError("record() needs an object");
      const { key, revisionId, filedDate, values } = input;
      if (typeof key !== "string" || key === "") throw new TypeError("key must be a non-empty string");
      if (typeof revisionId !== "string" || revisionId === "") throw new TypeError("revisionId must be a non-empty string");
      assertDate(filedDate, "filedDate");
      const proto = values && typeof values === "object" ? Object.getPrototypeOf(values) : undefined;
      if (!values || (proto !== Object.prototype && proto !== null)) throw new TypeError("values must be a plain object");

      let m = byKey.get(key);
      if (!m) byKey.set(key, (m = new Map()));
      const prev = m.get(revisionId);
      if (prev && canonical(prev.values) !== canonical(values)) throw new RevisionConflictError(key, revisionId);
      /** @type {Revision} */
      const rev = Object.freeze({
        key,
        revisionId,
        filedDate: prev && prev.filedDate < filedDate ? prev.filedDate : filedDate,
        values: Object.freeze({ ...values }),
        seq: prev ? prev.seq : seq++,
      });
      m.set(revisionId, rev);
      return rev;
    },

    /** Most recently filed revision (what a "latest" table would hold). @param {string} key */
    latest(key) {
      const all = sorted(key);
      return all.length ? all[all.length - 1] : null;
    },

    /**
     * The revision a reader would have seen on `date` (inclusive). Null when
     * nothing for this key had been published yet.
     * @param {string} key @param {string} date
     */
    asOf(key, date) {
      assertDate(date, "date");
      const all = sorted(key);
      let hit = null;
      for (const r of all) {
        if (r.filedDate <= date) hit = r;
        else break;
      }
      return hit;
    },

    /** Original disclosure date of a key; unaffected by later restatements. @param {string} key */
    firstDisclosed(key) {
      const all = sorted(key);
      return all.length ? all[0].filedDate : null;
    },

    /** All revisions of a key, oldest first. @param {string} key */
    history(key) {
      return sorted(key);
    },

    /** True when the key has more than one revision. @param {string} key */
    isRestated(key) {
      return (byKey.get(key)?.size ?? 0) > 1;
    },

    /**
     * What changed between consecutive revisions of a key.
     * @param {string} key
     * @returns {{ from: string, to: string, filedDate: string, changes: Change[] }[]}
     */
    changes(key) {
      const all = sorted(key);
      const out = [];
      for (let i = 1; i < all.length; i++) {
        out.push({
          from: all[i - 1].revisionId,
          to: all[i].revisionId,
          filedDate: all[i].filedDate,
          changes: diffValues(all[i - 1].values, all[i].values),
        });
      }
      return out;
    },

    /**
     * Every key as it stood on `date`. Keys with nothing public yet are omitted.
     * @param {string} date
     * @returns {Map<string, Revision>}
     */
    snapshot(date) {
      assertDate(date, "date");
      const out = new Map();
      for (const key of [...byKey.keys()].sort()) {
        const r = store.asOf(key, date);
        if (r) out.set(key, r);
      }
      return out;
    },

    /** @returns {string[]} */
    keys() {
      return [...byKey.keys()].sort();
    },

    /** Serializable form; feed it back to createRevisionStore() to restore. */
    toJSON() {
      const revisions = [];
      for (const m of byKey.values()) for (const r of m.values()) revisions.push(r);
      revisions.sort((a, b) => a.seq - b.seq);
      return { revisions: revisions.map(({ key, revisionId, filedDate, values }) => ({ key, revisionId, filedDate, values })) };
    },
  };

  for (const r of init?.revisions ?? []) store.record(r);
  return store;
}
