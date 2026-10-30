# worker/ gotchas

- A condition read in one statement and acted on in the next races a concurrent writer (a queue consumer, the hourly sweep, an admin save): put the condition in the UPDATE's `WHERE`, or run both statements in one `db.batch`. Check: any `SELECT` followed by an `UPDATE` of the same row without a guard on the value it read.
