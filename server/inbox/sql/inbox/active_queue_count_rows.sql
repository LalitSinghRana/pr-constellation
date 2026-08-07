SELECT
  COALESCE(json_extract(record, '$.item.kind'), '') AS kind,
  COALESCE(json_extract(record, '$.item.state'), '') AS state,
  COALESCE(json_extract(record, '$.item.draft'), 0) AS draft,
  COALESCE(json_extract(record, '$.item.authored'), 0) AS authored,
  COALESCE(json_extract(record, '$.item.reviewed'), 0) AS reviewed,
  COALESCE(json_extract(record, '$.item.latestReviewState'), '') AS latest_review_state,
  EXISTS (
    SELECT 1
    FROM json_each(queue_items.record, '$.item.signals') AS signal
    WHERE json_extract(signal.value, '$.kind') <> 'team-covered'
  ) AS has_attention_signal
FROM queue_items
WHERE (done_version IS NULL OR done_version <> version)
  AND json_type(record, '$.item') = 'object';
