DELETE FROM auto_reply_log
WHERE rowid NOT IN (
  SELECT (
    SELECT latest.rowid
    FROM auto_reply_log AS latest
    WHERE latest.rule_id = grouped.rule_id
      AND latest.sender = grouped.sender
    ORDER BY latest.sent_at DESC, latest.rowid DESC
    LIMIT 1
  )
  FROM auto_reply_log AS grouped
  GROUP BY grouped.rule_id, grouped.sender
);
--> statement-breakpoint
DROP INDEX `auto_reply_log_rule_sender_sent_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `auto_reply_log_rule_sender_unique` ON `auto_reply_log` (`rule_id`,`sender`);
