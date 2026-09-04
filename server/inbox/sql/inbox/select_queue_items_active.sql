SELECT id, record
FROM queue_items
WHERE done_version IS NULL
ORDER BY updated_at DESC, id
