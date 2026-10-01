-- Backfill emails.in_reply_to / references_header (added in 0062) for mail
-- received before those columns existed, from the header map every inbound row
-- already stores. `raw_headers` is a JSON object keyed by lowercase header name
-- (postal-mime), so the keys are "in-reply-to" and "references". Rows with no
-- or invalid raw_headers, or no such headers, stay NULL. Idempotent: only rows
-- with both columns still NULL are touched.
UPDATE `emails`
SET
  `in_reply_to` = NULLIF(TRIM(json_extract(`raw_headers`, '$."in-reply-to"')), ''),
  `references_header` = NULLIF(TRIM(json_extract(`raw_headers`, '$.references')), '')
WHERE `raw_headers` IS NOT NULL
  AND json_valid(`raw_headers`)
  AND `in_reply_to` IS NULL
  AND `references_header` IS NULL;
