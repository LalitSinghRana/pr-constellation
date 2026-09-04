SELECT id, record
FROM queue_items
WHERE done_version IS NOT NULL
ORDER BY updated_at DESC, id
