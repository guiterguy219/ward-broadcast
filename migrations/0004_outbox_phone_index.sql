-- "First text this month" looks up a member's recent outbox rows by phone.
CREATE INDEX outbox_phone ON outbox (phone, updated_at);
