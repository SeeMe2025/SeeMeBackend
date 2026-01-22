-- ============================================
-- SAFE MIGRATION SCRIPT FOR SUPABASE
-- Run this in Supabase SQL Editor
-- ============================================
-- This script:
-- ✅ Does NOT delete user data
-- ✅ Does NOT delete user_logs, errors, or ai_interactions
-- ============================================

-- STEP 1: VERIFY DATA EXISTS (SAFETY CHECK)
-- Run this first to see what you have
SELECT 
  'users' as table_name, 
  COUNT(*) as row_count 
FROM auth.users
UNION ALL
SELECT 'user_logs', COUNT(*) FROM user_logs
UNION ALL
SELECT 'errors', COUNT(*) FROM errors
UNION ALL
SELECT 'ai_interactions', COUNT(*) FROM ai_interactions
UNION ALL
SELECT 
  'ai_usage_exists (will be deleted)' as table_name,
  CASE
    WHEN to_regclass('public.ai_usage') IS NULL THEN 0
    ELSE 1
  END as row_count;

-- ============================================
-- STEP 2: DROP ONLY ai_usage TABLE (UNUSED)
-- ============================================
-- This table is NOT being used anymore
-- All data is in ai_interactions instead

DROP VIEW IF EXISTS ai_usage_summary;
DROP VIEW IF EXISTS ai_errors;
DROP INDEX IF EXISTS idx_ai_usage_user_id;
DROP INDEX IF EXISTS idx_ai_usage_provider;
DROP INDEX IF EXISTS idx_ai_usage_event_type;
DROP INDEX IF EXISTS idx_ai_usage_request_id;
DROP INDEX IF EXISTS idx_ai_usage_created_at;
DROP INDEX IF EXISTS idx_ai_usage_session_id;
DROP TABLE IF EXISTS ai_usage;

-- ============================================
-- STEP 3: FIX SESSION COUNTING
-- ============================================
-- Each user_logs entry = 1 session (each time user opens app)
-- Does NOT delete any data

-- Drop and recreate the function
DROP FUNCTION IF EXISTS get_user_logs_stats();

CREATE FUNCTION get_user_logs_stats()
RETURNS TABLE (
  user_id TEXT,
  session_count BIGINT,
  last_activity TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ul.user_id::TEXT,
    COUNT(*)::BIGINT as session_count,
    MAX(ul.session_date) as last_activity
  FROM user_logs ul
  GROUP BY ul.user_id::TEXT;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================
-- STEP 4: CREATE USER RATE LIMITING TABLE
-- ============================================
-- For flagging suspicious users
-- Creates new table, does NOT modify existing data

CREATE TABLE IF NOT EXISTS user_limits (
  user_id TEXT PRIMARY KEY,
  is_flagged BOOLEAN DEFAULT false,
  flag_reason TEXT,
  flagged_at TIMESTAMP WITH TIME ZONE,
  custom_rate_limit INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_limits_flagged ON user_limits(is_flagged) WHERE is_flagged = true;

-- ============================================
-- STEP 5: CREATE USER PROFILE VIEW
-- ============================================
-- Shows sessions, errors, AI stats together
-- Does NOT modify any data

CREATE OR REPLACE VIEW user_profile_stats AS
SELECT 
  u.id as user_id,
  u.email,
  u.created_at as user_created_at,
  
  -- Session stats
  COALESCE(logs.session_count, 0) as total_sessions,
  logs.last_activity,
  
  -- Error stats
  COALESCE(err.error_count, 0) as total_errors,
  err.last_error_date,
  err.recent_errors,
  
  -- AI stats
  COALESCE(ai.ai_count, 0) as total_ai_interactions,
  COALESCE(ai.success_count, 0) as successful_ai_interactions,
  CASE 
    WHEN ai.ai_count > 0 THEN ROUND((ai.success_count::DECIMAL / ai.ai_count) * 100, 2)
    ELSE 0
  END as ai_success_rate,
  
  -- Rate limiting flags
  COALESCE(ul.is_flagged, false) as is_suspicious,
  ul.flag_reason,
  ul.flagged_at

FROM auth.users u

LEFT JOIN (
  SELECT 
    user_id::TEXT as user_id,
    COUNT(*)::BIGINT as session_count,
    MAX(session_date) as last_activity
  FROM user_logs
  GROUP BY user_id::TEXT
) logs ON logs.user_id = u.id::TEXT

LEFT JOIN (
  SELECT 
    user_id::TEXT as user_id,
    COUNT(*)::BIGINT as error_count,
    MAX(timestamp) as last_error_date,
    ARRAY_AGG(
      json_build_object(
        'type', error_type,
        'message', error_message,
        'timestamp', timestamp
      ) ORDER BY timestamp DESC
    ) FILTER (WHERE timestamp > NOW() - INTERVAL '7 days') as recent_errors
  FROM errors
  GROUP BY user_id::TEXT
) err ON err.user_id = u.id::TEXT

LEFT JOIN (
  SELECT 
    user_id::TEXT as user_id,
    COUNT(*)::BIGINT as ai_count,
    COUNT(*) FILTER (WHERE status = 'success')::BIGINT as success_count
  FROM ai_interactions
  GROUP BY user_id::TEXT
) ai ON ai.user_id = u.id::TEXT

LEFT JOIN user_limits ul ON ul.user_id = u.id::TEXT

ORDER BY logs.last_activity DESC NULLS LAST;

-- ============================================
-- STEP 6: USER RATE LIMITING FUNCTIONS
-- ============================================

-- Function to flag suspicious user
CREATE OR REPLACE FUNCTION flag_user(
  p_user_id TEXT,
  p_reason TEXT,
  p_custom_limit INT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO user_limits (user_id, is_flagged, flag_reason, flagged_at, custom_rate_limit)
  VALUES (p_user_id, true, p_reason, NOW(), p_custom_limit)
  ON CONFLICT (user_id) 
  DO UPDATE SET 
    is_flagged = true,
    flag_reason = p_reason,
    flagged_at = NOW(),
    custom_rate_limit = p_custom_limit,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to unflag user
CREATE OR REPLACE FUNCTION unflag_user(p_user_id TEXT)
RETURNS VOID AS $$
BEGIN
  UPDATE user_limits 
  SET 
    is_flagged = false,
    flag_reason = NULL,
    flagged_at = NULL,
    custom_rate_limit = NULL,
    updated_at = NOW()
  WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- STEP 6: CREATE ONBOARDING METRICS TABLE
-- ============================================
-- Tracks onboarding screen time
-- Creates new table, does NOT modify existing data

CREATE TABLE IF NOT EXISTS onboarding_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT NOT NULL UNIQUE,
  
  screen_time_seconds INT,
  completed_at TIMESTAMP WITH TIME ZONE,
  
  steps_completed TEXT[],
  total_steps INT,
  
  selected_coach TEXT,
  selected_voice TEXT,
  notification_preferences JSONB,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_user_id ON onboarding_metrics(user_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_completed ON onboarding_metrics(completed_at) WHERE completed_at IS NOT NULL;

-- ============================================
-- STEP 7: CREATE FILTERED LOGS VIEW
-- ============================================
-- Excludes summary logs from dashboard
-- Does NOT modify any data

CREATE OR REPLACE VIEW user_logs_filtered AS
SELECT 
  id,
  user_id,
  logs,
  session_date,
  created_at
FROM user_logs
WHERE 
  NOT EXISTS (
    SELECT 1 
    FROM jsonb_array_elements(logs) AS log_entry
    WHERE log_entry->>'action' ILIKE '%summary%'
       OR log_entry->>'action' ILIKE '%summarize%'
       OR log_entry->>'type' = 'summary'
  );

-- ============================================
-- STEP 8: HELPER FUNCTIONS
-- ============================================

-- Get flagged users
CREATE OR REPLACE FUNCTION get_flagged_users()
RETURNS TABLE (
  user_id TEXT,
  email TEXT,
  flag_reason TEXT,
  flagged_at TIMESTAMP WITH TIME ZONE,
  custom_rate_limit INT,
  total_sessions BIGINT,
  total_errors BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ul.user_id,
    u.email,
    ul.flag_reason,
    ul.flagged_at,
    ul.custom_rate_limit,
    COALESCE(logs.session_count, 0) as total_sessions,
    COALESCE(err.error_count, 0) as total_errors
  FROM user_limits ul
  JOIN auth.users u ON u.id::TEXT = ul.user_id
  LEFT JOIN (
    SELECT user_id::TEXT as user_id, COUNT(*)::BIGINT as session_count
    FROM user_logs
    GROUP BY user_id::TEXT
  ) logs ON ul.user_id = logs.user_id
  LEFT JOIN (
    SELECT user_id::TEXT as user_id, COUNT(*)::BIGINT as error_count
    FROM errors
    GROUP BY user_id::TEXT
  ) err ON ul.user_id = err.user_id
  WHERE ul.is_flagged = true
  ORDER BY ul.flagged_at DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- Get user session details
CREATE OR REPLACE FUNCTION get_user_sessions(p_user_id TEXT)
RETURNS TABLE (
  session_date DATE,
  log_count INT,
  first_activity TIMESTAMP WITH TIME ZONE,
  last_activity TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    DATE(ul.session_date) as session_date,
    jsonb_array_length(ul.logs) as log_count,
    MIN(ul.session_date) as first_activity,
    MAX(ul.session_date) as last_activity
  FROM user_logs ul
  WHERE ul.user_id = p_user_id
  GROUP BY DATE(ul.session_date)
  ORDER BY session_date DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- Update error stats function
DROP FUNCTION IF EXISTS get_user_errors_stats();

CREATE FUNCTION get_user_errors_stats()
RETURNS TABLE (
  user_id TEXT,
  error_count BIGINT,
  last_error_date TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    e.user_id,
    COUNT(*)::BIGINT as error_count,
    MAX(e.timestamp) as last_error_date
  FROM errors e
  GROUP BY e.user_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================
-- STEP 9: VERIFY EVERYTHING WORKED
-- ============================================
-- Run this to confirm all data is still there

SELECT 
  'AFTER MIGRATION' as status,
  'users' as table_name, 
  COUNT(*) as row_count 
FROM auth.users
UNION ALL
SELECT 'AFTER MIGRATION', 'user_logs', COUNT(*) FROM user_logs
UNION ALL
SELECT 'AFTER MIGRATION', 'errors', COUNT(*) FROM errors
UNION ALL
SELECT 'AFTER MIGRATION', 'ai_interactions', COUNT(*) FROM ai_interactions;

-- Test the new function
SELECT * FROM get_user_logs_stats() LIMIT 5;
