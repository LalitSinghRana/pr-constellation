SELECT id, record
FROM queue_items

ORDER BY updated_at DESC, id
LIMIT ? OFFSET ?
