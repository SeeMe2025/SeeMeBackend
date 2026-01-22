-- Drop unused ai_usage table and associated objects
-- This table was replaced by ai_interactions for proper analytics tracking

-- Drop views that depend on ai_usage table
DROP VIEW IF EXISTS ai_usage_summary;
DROP VIEW IF EXISTS ai_errors;

-- Drop indexes
DROP INDEX IF EXISTS idx_ai_usage_user_id;
DROP INDEX IF EXISTS idx_ai_usage_provider;
DROP INDEX IF EXISTS idx_ai_usage_event_type;
DROP INDEX IF EXISTS idx_ai_usage_request_id;
DROP INDEX IF EXISTS idx_ai_usage_created_at;
DROP INDEX IF EXISTS idx_ai_usage_session_id;

-- Drop the table
DROP TABLE IF EXISTS ai_usage;

-- Verify ai_interactions table exists and has proper structure
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_interactions') THEN
        RAISE EXCEPTION 'ai_interactions table does not exist! Analytics will not work.';
    END IF;
END $$;

COMMENT ON TABLE ai_interactions IS 'Primary analytics table for AI requests, responses, and errors. Replaced ai_usage table.';
