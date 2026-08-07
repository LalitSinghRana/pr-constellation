SELECT id, record
FROM queue_items
WHERE done_version = version
ORDER BY updated_at DESC, id
