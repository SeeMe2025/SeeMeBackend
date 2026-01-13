-- Enhanced AI Error Tracking - Add Missing Fields to Existing Tables
-- This migration enhances the EXISTING ai_interactions and errors tables
-- instead of creating new tables

-- ============================================
-- ENHANCE ai_interactions TABLE
-- ============================================

-- Add missing fields for better AI tracking
ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS prompt_type TEXT;
ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS session_id UUID;
ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS coach_id UUID;
ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS feature_name TEXT;
ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS message_length INT;
ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS response_length INT;
ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS from_cache BOOLEAN DEFAULT false;
ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS stream_aborted BOOLEAN DEFAULT false;

-- Add error tracking fields to ai_interactions
ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE ai_interactions ADD COLUMN IF NOT EXISTS stack_trace TEXT;

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_ai_interactions_request_id ON ai_interactions(request_id);
CREATE INDEX IF NOT EXISTS idx_ai_interactions_session_id ON ai_interactions(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_interactions_model ON ai_interactions(model);
CREATE INDEX IF NOT EXISTS idx_ai_interactions_prompt_type ON ai_interactions(prompt_type);
CREATE INDEX IF NOT EXISTS idx_ai_interactions_status ON ai_interactions(status);

-- ============================================
-- ENHANCE errors TABLE
-- ============================================

-- Add missing fields for better error tracking
ALTER TABLE errors ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE errors ADD COLUMN IF NOT EXISTS stack_trace TEXT;
ALTER TABLE errors ADD COLUMN IF NOT EXISTS session_id UUID;
ALTER TABLE errors ADD COLUMN IF NOT EXISTS request_id TEXT;

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_errors_error_code ON errors(error_code) WHERE error_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_errors_session_id ON errors(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_errors_request_id ON errors(request_id) WHERE request_id IS NOT NULL;

-- ============================================
-- DASHBOARD VIEWS
-- ============================================

-- View for AI error analysis (using ai_interactions table)
CREATE OR REPLACE VIEW ai_errors_detailed AS
SELECT
  id,
  user_id,
  provider,
  model,
  prompt_type,
  interaction_type,
  status,
  error_message,
  error_code,
  stack_trace,
  request_id,
  session_id,
  coach_id,
  feature_name,
  response_time_ms,
  tokens_used,
  timestamp
FROM ai_interactions
WHERE status = 'error' OR status = 'failure'
ORDER BY timestamp DESC;

-- View for AI error frequency
CREATE OR REPLACE VIEW ai_error_frequency AS
SELECT
  error_code,
  provider,
  model,
  COUNT(*) as error_count,
  COUNT(DISTINCT user_id) as affected_users,
  MAX(timestamp) as last_occurrence,
  MIN(timestamp) as first_occurrence
FROM ai_interactions
WHERE status = 'error' OR status = 'failure'
GROUP BY error_code, provider, model
ORDER BY error_count DESC;

-- View for streaming issues
CREATE OR REPLACE VIEW ai_streaming_issues AS
SELECT
  user_id,
  provider,
  model,
  prompt_type,
  request_id,
  response_time_ms,
  stream_aborted,
  timestamp
FROM ai_interactions
WHERE stream_aborted = true
ORDER BY timestamp DESC;

-- View for AI success rate by provider
CREATE OR REPLACE VIEW ai_success_rate AS
SELECT
  provider,
  model,
  COUNT(*) as total_requests,
  COUNT(*) FILTER (WHERE status = 'success') as successful_requests,
  COUNT(*) FILTER (WHERE status = 'error' OR status = 'failure') as failed_requests,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE status = 'success') / NULLIF(COUNT(*), 0),
    2
  ) as success_rate_percent,
  AVG(response_time_ms) as avg_response_time_ms
FROM ai_interactions
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY provider, model
ORDER BY total_requests DESC;

-- ============================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================

COMMENT ON COLUMN ai_interactions.model IS 'AI model used (e.g., gpt-5.1, claude-3-5-sonnet)';
COMMENT ON COLUMN ai_interactions.prompt_type IS 'Type of prompt (e.g., conversation, summary, affirmation)';
COMMENT ON COLUMN ai_interactions.request_id IS 'Unique request ID for correlation with backend logs';
COMMENT ON COLUMN ai_interactions.session_id IS 'User session ID for tracking conversation context';
COMMENT ON COLUMN ai_interactions.coach_id IS 'Coach ID for tracking which coach was used';
COMMENT ON COLUMN ai_interactions.error_code IS 'Specific error code (e.g., STREAM_TIMEOUT, ECONNRESET)';
COMMENT ON COLUMN ai_interactions.stack_trace IS 'Backend stack trace for debugging (first 500 chars)';
COMMENT ON COLUMN ai_interactions.stream_aborted IS 'Whether the stream was aborted due to client disconnect';
