SELECT
  count(*) AS total,
  count(*) FILTER (WHERE done_version = version) AS done,
  count(*) FILTER (WHERE done_version IS NULL OR done_version <> version) AS active
FROM queue_items;
