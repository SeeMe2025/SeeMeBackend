-- AI Usage Tracking Table
-- Tracks all AI requests, responses, and errors for monitoring and analytics

CREATE TABLE IF NOT EXISTS ai_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  provider TEXT NOT NULL, -- 'openai', 'anthropic', 'elevenlabs'
  model TEXT, -- 'gpt-4o', 'claude-3-5-sonnet-20241022', etc.
  prompt_type TEXT, -- 'conversation', 'summary', 'affirmation', etc.
  event_type TEXT NOT NULL, -- 'request', 'response', 'error'

  -- Request data
  message_length INT,
  request_id TEXT NOT NULL,

  -- Response data
  response_length INT,
  tokens_used INT,
  latency_ms INT,
  from_cache BOOLEAN DEFAULT false,

  -- Error data
  error_type TEXT,
  error_message TEXT,

  -- Context
  session_id UUID,
  coach_id UUID,
  feature_name TEXT, -- 'chat', 'daily_metrics', 'affirmation', etc.

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX idx_ai_usage_user_id ON ai_usage(user_id);
CREATE INDEX idx_ai_usage_provider ON ai_usage(provider);
CREATE INDEX idx_ai_usage_event_type ON ai_usage(event_type);
CREATE INDEX idx_ai_usage_request_id ON ai_usage(request_id);
CREATE INDEX idx_ai_usage_created_at ON ai_usage(created_at DESC);
CREATE INDEX idx_ai_usage_session_id ON ai_usage(session_id);

-- View for monitoring AI usage summary by user
CREATE OR REPLACE VIEW ai_usage_summary AS
SELECT
  user_id,
  provider,
  COUNT(*) FILTER (WHERE event_type = 'request') AS total_requests,
  COUNT(*) FILTER (WHERE event_type = 'error') AS total_errors,
  SUM(tokens_used) AS total_tokens,
  AVG(latency_ms) AS avg_latency_ms,
  COUNT(*) FILTER (WHERE from_cache = true) AS cache_hits,
  DATE(created_at) AS date
FROM ai_usage
WHERE event_type IN ('request', 'response', 'error')
GROUP BY user_id, provider, DATE(created_at)
ORDER BY date DESC;

-- View for monitoring errors
CREATE OR REPLACE VIEW ai_errors AS
SELECT
  user_id,
  provider,
  prompt_type,
  error_type,
  error_message,
  request_id,
  created_at
FROM ai_usage
WHERE event_type = 'error'
ORDER BY created_at DESC;
