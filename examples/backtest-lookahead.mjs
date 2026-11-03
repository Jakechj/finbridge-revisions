// Run: node examples/backtest-lookahead.mjs
// Shows why a backtest must read restated figures by filing date, not by fiscal period.
import { createRevisionStore } from "../src/index.js";

const store = createRevisionStore();
const key = "EXAMPLE-CO:2025:FY";

// Original annual report.
store.record({ key, revisionId: "filing-0001", filedDate: "2026-03-14", values: { revenue: 1200, operating_income: 150 } });
// Amended report two months later lowers operating income.
store.record({ key, revisionId: "filing-0002", filedDate: "2026-05-20", values: { revenue: 1200, operating_income: 90 } });

const rebalance = "2026-04-01";
const naive = store.latest(key);
const correct = store.asOf(key, rebalance);

console.log(`Rebalance date:           ${rebalance}`);
console.log(`Latest table says:        operating_income=${naive.values.operating_income} (filed ${naive.filedDate}) <- look-ahead`);
console.log(`Point-in-time says:       operating_income=${correct.values.operating_income} (filed ${correct.filedDate})`);
console.log(`First disclosed:          ${store.firstDisclosed(key)}`);
console.log("Changes:", JSON.stringify(store.changes(key), null, 2));
