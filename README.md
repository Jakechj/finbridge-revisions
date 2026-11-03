# finbridge-revisions

Append-only revision history for records that get corrected after publication,
with point-in-time reads.

## Problem

Companies amend financial statements. If you store only the latest numbers,
two things go wrong:

1. The original figures are gone. You cannot show what was first reported or
   what the amendment changed.
2. Backtests read the future. A strategy evaluated on 1 April sees an amendment
   filed on 20 May, because the "latest" row has no notion of when each number
   became public. Copying the amendment's values onto the original filing date
   has the same effect.

This library keeps every revision, stamps each with the date it became public,
and answers "what was known on date T". It has no runtime dependencies and no
storage of its own beyond an in-memory map; the same rules can be mirrored in
any database.

## Install

```sh
npm install finbridge-revisions
```

Node 18 or later. ESM only.

## Minimal example

```js
import { createRevisionStore } from "finbridge-revisions";

const store = createRevisionStore();
const key = "EXAMPLE-CO:2025:FY";

store.record({ key, revisionId: "filing-0001", filedDate: "2026-03-14", values: { operating_income: 150 } });
store.record({ key, revisionId: "filing-0002", filedDate: "2026-05-20", values: { operating_income: 90 } });

store.latest(key).values.operating_income;            // 90
store.asOf(key, "2026-04-01").values.operating_income; // 150  (amendment not public yet)
store.firstDisclosed(key);                             // "2026-03-14"
store.changes(key);
// [{ from: "filing-0001", to: "filing-0002", filedDate: "2026-05-20",
//    changes: [{ field: "operating_income", before: 150, after: 90 }] }]
```

A runnable version is in `examples/backtest-lookahead.mjs`.

## API

### `createRevisionStore(init?)`

Returns a store. `init` is the output of `store.toJSON()`.

| Method | Returns |
| --- | --- |
| `record({ key, revisionId, filedDate, values })` | The stored revision. A new `revisionId` adds a revision; an existing one updates it in place. |
| `latest(key)` | Most recently filed revision, or `null`. |
| `asOf(key, date)` | Last revision with `filedDate <= date`, or `null`. |
| `firstDisclosed(key)` | Earliest `filedDate` for the key, or `null`. |
| `history(key)` | All revisions, oldest first. |
| `isRestated(key)` | `true` when the key has more than one revision. |
| `changes(key)` | Field-level diffs between consecutive revisions. |
| `snapshot(date)` | `Map<key, revision>` of every key as of `date`. Keys not yet public are left out. |
| `keys()` | All keys, sorted. |
| `toJSON()` | `{ revisions: [...] }` in insertion order. |

Fields:

- `key`: identity of the record being revised. Build it from whatever defines
  "the same figure" in your data, e.g. `company:fiscal_year:period:basis`.
- `revisionId`: id of the document that produced the values (filing or
  receipt number). Amendments have their own id, so originals and amendments
  separate naturally.
- `filedDate`: `"YYYY-MM-DD"`, the date the document became public. Required.
- `values`: a plain object. It is shallow-copied and frozen.

### `pickAsOf(revisions, date)`

Pure function over an array of `{ filedDate, ... }` objects. Use it when the
revisions already live in your own table.

### `diffValues(before, after)`

Shallow field diff using `Object.is`, sorted by field name.

## Design notes

- **Never overwrite across revisions.** The primary key of a revision is
  `(key, revisionId)`. A correction is a new row, not an update.
- **Re-ingest is idempotent.** Recording the same `(key, revisionId)` again
  replaces its values but keeps the earlier of the two `filedDate`s, so a late
  re-download does not move a disclosure date.
- **First disclosure date is derived, not stored.** It is the minimum
  `filedDate` across revisions, so no code path can push it forward when an
  amendment arrives.
- **`filedDate` is mandatory.** A revision without a known publication date
  cannot be placed in time safely, so it is rejected rather than guessed.
- **Ties.** Revisions filed on the same date are ordered by insertion order.
  `pickAsOf` picks the later array element on ties.
- **Dates are strings.** `"YYYY-MM-DD"` compares correctly as text and avoids
  time zone conversion. If you need intraday precision, use a sortable
  timestamp string in your own `pickAsOf`-style query.

## Using your own database

The same rules in SQL:

```sql
CREATE TABLE revisions (
  key         TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  filed_date  TEXT NOT NULL,
  -- value columns ...
  PRIMARY KEY (key, revision_id)
);

-- Point-in-time read
SELECT * FROM revisions
WHERE key = ? AND filed_date <= ?
ORDER BY filed_date DESC
LIMIT 1;
```

Keep a separate "latest" table if reads of current values must be fast, but
write the revision row first, and never update the original disclosure date
on that latest table from an amendment.

## Origin

Extracted from the restatement handling in the FinBridge disclosure server and
rewritten as a standalone, storage-agnostic module.

## License

MIT
