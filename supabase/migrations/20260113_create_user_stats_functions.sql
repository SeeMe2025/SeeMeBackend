-- Function to get user logs statistics (session count and last activity)
CREATE OR REPLACE FUNCTION get_user_logs_stats()
RETURNS TABLE (
  user_id TEXT,
  session_count BIGINT,
  last_activity TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ul.user_id,
    COUNT(*)::BIGINT as session_count,
    MAX(ul.session_date) as last_activity
  FROM user_logs ul
  GROUP BY ul.user_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to get user errors statistics
CREATE OR REPLACE FUNCTION get_user_errors_stats()
RETURNS TABLE (
  user_id TEXT,
  error_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    e.user_id,
    COUNT(*)::BIGINT as error_count
  FROM errors e
  GROUP BY e.user_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to get user AI interaction statistics
CREATE OR REPLACE FUNCTION get_user_ai_stats()
RETURNS TABLE (
  user_id TEXT,
  ai_count BIGINT,
  success_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ai.user_id,
    COUNT(*)::BIGINT as ai_count,
    COUNT(*) FILTER (WHERE ai.status = 'success')::BIGINT as success_count
  FROM ai_interactions ai
  GROUP BY ai.user_id;
END;
$$ LANGUAGE plpgsql STABLE;
