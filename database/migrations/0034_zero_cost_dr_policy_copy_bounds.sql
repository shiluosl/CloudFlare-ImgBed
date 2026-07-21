-- Keep D1 policy data aligned with the two synchronous-copy zero-cost limit.
-- Earlier V3 schema versions allowed a value of three for future expansion.
UPDATE storage_policies
SET required_copies = MIN(required_copies, 2),
    minimum_readable_copies = MIN(MIN(minimum_readable_copies, 2), required_copies),
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE required_copies > 2
   OR minimum_readable_copies > 2
   OR minimum_readable_copies > required_copies;

CREATE TRIGGER IF NOT EXISTS trg_storage_policies_copy_bounds_insert
BEFORE INSERT ON storage_policies
WHEN NEW.required_copies NOT BETWEEN 1 AND 2
  OR NEW.minimum_readable_copies NOT BETWEEN 1 AND 2
  OR NEW.minimum_readable_copies > NEW.required_copies
BEGIN
  SELECT RAISE(ABORT, 'storage policy copy thresholds must fit the two synchronous-copy limit');
END;

CREATE TRIGGER IF NOT EXISTS trg_storage_policies_copy_bounds_update
BEFORE UPDATE OF required_copies, minimum_readable_copies ON storage_policies
WHEN NEW.required_copies NOT BETWEEN 1 AND 2
  OR NEW.minimum_readable_copies NOT BETWEEN 1 AND 2
  OR NEW.minimum_readable_copies > NEW.required_copies
BEGIN
  SELECT RAISE(ABORT, 'storage policy copy thresholds must fit the two synchronous-copy limit');
END;
