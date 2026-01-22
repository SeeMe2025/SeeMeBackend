-- Debug query to check user ID format mismatch
-- Run this in Supabase SQL Editor

-- Check users table ID format
SELECT 
  'users table' as source,
  id,
  id::TEXT as id_as_text,
  pg_typeof(id) as id_type
FROM auth.users
LIMIT 3;

-- Check what get_user_logs_stats returns
SELECT 
  'get_user_logs_stats()' as source,
  user_id,
  session_count,
  pg_typeof(user_id) as user_id_type
FROM get_user_logs_stats()
LIMIT 3;

-- Check if IDs match
SELECT 
  u.id as user_table_id,
  u.id::TEXT as user_table_id_text,
  stats.user_id as stats_user_id,
  stats.session_count,
  CASE 
    WHEN u.id::TEXT = stats.user_id THEN 'MATCH'
    ELSE 'NO MATCH'
  END as match_status
FROM auth.users u
LEFT JOIN get_user_logs_stats() stats ON u.id::TEXT = stats.user_id
LIMIT 5;
