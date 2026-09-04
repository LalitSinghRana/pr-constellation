SELECT
  count(*) AS total,
  count(*) FILTER (WHERE done_version IS NOT NULL) AS done,
  count(*) FILTER (WHERE done_version IS NULL) AS active
FROM queue_items;
