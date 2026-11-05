ALTER TABLE mock_calls
  ADD COLUMN IF NOT EXISTS completed_clock_at bigint;
