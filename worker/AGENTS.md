# worker/ gotchas

- A condition read in one statement and acted on in the next races a concurrent writer (a queue consumer, the hourly sweep, an admin save): put the condition in the UPDATE's `WHERE`, or run both statements in one `db.batch`. Check: any `SELECT` followed by an `UPDATE` of the same row without a guard on the value it read.
- `env.R2.delete(keys)` takes at most 1,000 keys per call: chunk the list. Check: any `R2.delete` fed by a query result.
- One Worker invocation may run at most 1,000 D1 queries (a `db.batch` counts as one), shared by every step of the cron chain: size a sweep by statement count, not row count. Check: any loop in `scheduledChain` that calls a per-row helper.
