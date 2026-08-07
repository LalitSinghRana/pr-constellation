SELECT id, record
FROM queue_items
WHERE done_version IS NULL OR done_version <> version
ORDER BY updated_at DESC, id
