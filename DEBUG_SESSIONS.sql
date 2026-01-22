
-- Debug query to check user_logs data
-- Run this in Supabase SQL Editor to see what's happening

-- 1. Check if user_logs table has data
SELECT COUNT(*) as total_logs FROM user_logs;

-- 2. Check sample of user_logs
SELECT user_id, session_date, created_at 
FROM user_logs 
ORDER BY session_date DESC 
LIMIT 10;

-- 3. Check what the current function returns
SELECT * FROM get_user_logs_stats() 
ORDER BY session_count DESC 
LIMIT 10;

-- 4. Check if there are users with logs
SELECT 
  u.id,
  u.name,
  COUNT(ul.id) as log_count,
  MAX(ul.session_date) as last_session
FROM users u
LEFT JOIN user_logs ul ON u.id = ul.user_id
GROUP BY u.id, u.name
ORDER BY log_count DESC
LIMIT 10;

-- 5. Check if user_id format matches between tables
SELECT 
  'users' as source,
  id as sample_id,
  LENGTH(id) as id_length,
  id::text LIKE '%-%' as has_dashes
FROM users 
LIMIT 1
UNION ALL
SELECT 
  'user_logs' as source,
  user_id as sample_id,
  LENGTH(user_id) as id_length,
  user_id LIKE '%-%' as has_dashes
FROM user_logs 
LIMIT 1;
