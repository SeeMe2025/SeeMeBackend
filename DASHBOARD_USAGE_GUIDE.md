# Dashboard Usage Guide
**Post-Security Incident Dashboard Improvements**

## Overview

This guide explains how to use the improved dashboard features after the security incident fixes. All improvements are live after running migration `006_dashboard_improvements.sql`.

---

## 🔧 What Was Fixed

### 1. **Session Counting** ✅
- **Problem**: Duplicate sessions counted multiple times
- **Solution**: 1 session = 1 app open (unique by date)
- **Implementation**: Unique index on `user_id + DATE(session_date)`

### 2. **User Profiles** ✅
- **Problem**: Errors not visible in user profiles
- **Solution**: New `user_profile_stats` view includes errors
- **Shows**: Sessions, errors, AI stats, suspicious flags

### 3. **Onboarding Metrics** ✅
- **Problem**: Missing screen_time, unnecessary metrics
- **Solution**: New `onboarding_metrics` table
- **Tracks**: screen_time_seconds, steps completed, selections

### 4. **Rate Limiting** ✅
- **Problem**: No per-user rate limiting for suspicious users
- **Solution**: `user_limits` table with custom limits
- **Features**: Flag users, set custom limits, track reasons

### 5. **Log Filtering** ✅
- **Problem**: Summaries appearing in logs
- **Solution**: iOS filters out summary logs before saving
- **Also**: `user_logs_filtered` view excludes summaries

---

## 📊 Dashboard Views

### 1. User Profile Stats
**View**: `user_profile_stats`

```sql
SELECT * FROM user_profile_stats
WHERE user_id = 'your-user-id';
```

**Returns**:
- `total_sessions` - Deduplicated session count
- `last_activity` - Last session date
- `total_errors` - Error count
- `recent_errors` - Last 7 days errors (JSON array)
- `total_ai_interactions` - AI request count
- `ai_success_rate` - Success percentage
- `is_suspicious` - Flagged status
- `flag_reason` - Why flagged

**Example**:
```sql
-- Get all users with errors
SELECT user_id, email, total_errors, total_sessions
FROM user_profile_stats
WHERE total_errors > 0
ORDER BY total_errors DESC;

-- Get users with low AI success rate
SELECT user_id, email, ai_success_rate, total_ai_interactions
FROM user_profile_stats
WHERE ai_success_rate < 80 AND total_ai_interactions > 10
ORDER BY ai_success_rate ASC;
```

### 2. Filtered Logs (No Summaries)
**View**: `user_logs_filtered`

```sql
SELECT * FROM user_logs_filtered
WHERE user_id = 'your-user-id'
ORDER BY session_date DESC
LIMIT 10;
```

**Use**: Display logs in dashboard without summary clutter

### 3. Onboarding Metrics
**Table**: `onboarding_metrics`

```sql
-- Get onboarding completion stats
SELECT 
  COUNT(*) as total_users,
  AVG(screen_time_seconds) as avg_time_seconds,
  AVG(screen_time_seconds / 60.0) as avg_time_minutes,
  COUNT(*) FILTER (WHERE completed_at IS NOT NULL) as completed_count
FROM onboarding_metrics;

-- Get users who took longest in onboarding
SELECT user_id, screen_time_seconds, completed_at
FROM onboarding_metrics
WHERE completed_at IS NOT NULL
ORDER BY screen_time_seconds DESC
LIMIT 10;
```

---

## 🚨 Security Functions

### Flag Suspicious User

```sql
-- Flag a user with custom rate limit
SELECT flag_user(
  'user-id-here',
  'Suspicious activity: 100 requests in 1 minute',
  5  -- Custom limit: only 5 requests per day
);

-- Flag without custom limit (uses default)
SELECT flag_user(
  'user-id-here',
  'Potential bot behavior detected',
  NULL
);
```

### Unflag User

```sql
SELECT unflag_user('user-id-here');
```

### Get All Flagged Users

```sql
SELECT * FROM get_flagged_users();
```

**Returns**:
- `user_id`, `email`
- `flag_reason`
- `flagged_at`
- `custom_rate_limit`
- `total_sessions`, `total_errors`

**Example**:
```sql
-- Get flagged users with high error rates
SELECT * FROM get_flagged_users()
WHERE total_errors > 10
ORDER BY total_errors DESC;
```

---

## 📈 Session Analytics

### Get User Sessions (Deduplicated)

```sql
SELECT * FROM get_user_sessions('user-id-here');
```

**Returns**:
- `session_date` - Unique date
- `log_count` - Number of logs that day
- `first_activity` - First log timestamp
- `last_activity` - Last log timestamp

**Example**:
```sql
-- Get session duration per day
SELECT 
  session_date,
  EXTRACT(EPOCH FROM (last_activity - first_activity)) / 60 as duration_minutes
FROM get_user_sessions('user-id-here')
ORDER BY session_date DESC;
```

### Session Count Stats

```sql
-- Total sessions per user
SELECT * FROM get_user_logs_stats()
ORDER BY session_count DESC
LIMIT 10;

-- Active users (sessions in last 7 days)
SELECT 
  user_id,
  session_count,
  last_activity
FROM get_user_logs_stats()
WHERE last_activity > NOW() - INTERVAL '7 days'
ORDER BY session_count DESC;
```

---

## 🔍 Error Analytics

### Get User Errors

```sql
SELECT * FROM get_user_errors_stats()
WHERE error_count > 0
ORDER BY error_count DESC;
```

### Recent Errors from User Profile

```sql
SELECT 
  user_id,
  email,
  recent_errors
FROM user_profile_stats
WHERE total_errors > 0;
```

The `recent_errors` field contains JSON array:
```json
[
  {
    "type": "network_error",
    "message": "Connection timeout",
    "timestamp": "2026-01-21T12:00:00Z"
  }
]
```

---

## 🤖 AI Analytics

### AI Interaction Stats

```sql
SELECT * FROM get_user_ai_stats()
ORDER BY ai_count DESC
LIMIT 10;
```

### Combined User Stats

```sql
-- Get comprehensive user overview
SELECT 
  u.user_id,
  u.email,
  logs.session_count,
  logs.last_activity,
  err.error_count,
  ai.ai_count,
  ai.success_count,
  ROUND((ai.success_count::DECIMAL / NULLIF(ai.ai_count, 0)) * 100, 2) as success_rate
FROM auth.users u
LEFT JOIN get_user_logs_stats() logs ON u.id::TEXT = logs.user_id
LEFT JOIN get_user_errors_stats() err ON u.id::TEXT = err.user_id
LEFT JOIN get_user_ai_stats() ai ON u.id::TEXT = ai.user_id
ORDER BY logs.last_activity DESC NULLS LAST;
```

---

## 🎯 Common Dashboard Queries

### 1. Most Active Users

```sql
SELECT 
  email,
  total_sessions,
  total_ai_interactions,
  last_activity
FROM user_profile_stats
WHERE last_activity > NOW() - INTERVAL '30 days'
ORDER BY total_sessions DESC
LIMIT 20;
```

### 2. Users with Issues

```sql
SELECT 
  email,
  total_errors,
  ai_success_rate,
  total_ai_interactions,
  is_suspicious,
  flag_reason
FROM user_profile_stats
WHERE total_errors > 5 OR ai_success_rate < 70
ORDER BY total_errors DESC;
```

### 3. Onboarding Funnel

```sql
SELECT 
  COUNT(*) as started,
  COUNT(*) FILTER (WHERE completed_at IS NOT NULL) as completed,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE completed_at IS NOT NULL) / COUNT(*),
    2
  ) as completion_rate,
  AVG(screen_time_seconds) FILTER (WHERE completed_at IS NOT NULL) as avg_completion_time_sec
FROM onboarding_metrics;
```

### 4. Daily Active Users

```sql
SELECT 
  DATE(session_date) as date,
  COUNT(DISTINCT user_id) as active_users
FROM user_logs
WHERE session_date > NOW() - INTERVAL '30 days'
GROUP BY DATE(session_date)
ORDER BY date DESC;
```

### 5. Error Rate Trend

```sql
SELECT 
  DATE(timestamp) as date,
  COUNT(*) as error_count,
  COUNT(DISTINCT user_id) as affected_users
FROM errors
WHERE timestamp > NOW() - INTERVAL '30 days'
GROUP BY DATE(timestamp)
ORDER BY date DESC;
```

---

## 🔐 Rate Limiting in Action

### Backend Behavior

When a flagged user makes a request:

1. Backend checks `user_limits` table
2. If `is_flagged = true` and `custom_rate_limit` is set:
   - Uses custom limit instead of default
   - Logs: `⚠️ Flagged user {userId} has custom limit: {limit}`
3. If limit exceeded:
   - Returns 429 error
   - Shows custom limit in error message

### Example Flow

```sql
-- Flag user with strict limit
SELECT flag_user('suspicious-user-id', 'Bot-like behavior', 3);

-- User tries to make 4th request today
-- Backend returns: 429 Too Many Requests
-- Error: "Rate limit exceeded: 3/3 text sessions used"
```

---

## 📝 iOS App Changes

### 1. Summary Filtering
iOS now filters out summary logs before saving:
```swift
// Filters out logs containing:
// - "summary"
// - "summarize"  
// - "summarizing"
```

### 2. Session Deduplication
Database enforces unique sessions per day:
```sql
-- Only one entry per user per day
CREATE UNIQUE INDEX idx_user_logs_unique_session 
ON user_logs(user_id, DATE(session_date));
```

### 3. Onboarding Tracking
iOS should track (to be implemented):
- `screen_time_seconds` - Total time in onboarding
- `steps_completed` - Array of completed steps
- `selected_coach`, `selected_voice` - User choices

---

## 🚀 Migration Steps

1. **Run Migration**:
   ```bash
   # In Supabase SQL Editor
   # Paste contents of: 006_dashboard_improvements.sql
   ```

2. **Verify Tables**:
   ```sql
   -- Check new tables exist
   SELECT table_name FROM information_schema.tables 
   WHERE table_schema = 'public' 
   AND table_name IN ('user_limits', 'onboarding_metrics');
   ```

3. **Test Views**:
   ```sql
   SELECT * FROM user_profile_stats LIMIT 1;
   SELECT * FROM user_logs_filtered LIMIT 1;
   ```

4. **Test Functions**:
   ```sql
   SELECT * FROM get_flagged_users();
   SELECT * FROM get_user_sessions('test-user-id');
   ```

---

## 📞 Support

### Troubleshooting

**Sessions still showing duplicates?**
- Check if unique index exists:
  ```sql
  SELECT indexname FROM pg_indexes 
  WHERE tablename = 'user_logs' 
  AND indexname = 'idx_user_logs_unique_session';
  ```

**Summaries still in logs?**
- iOS change required - deploy latest iOS app
- Or use `user_logs_filtered` view in dashboard

**Custom rate limits not working?**
- Check backend logs for: `⚠️ Flagged user`
- Verify `user_limits` table has entry:
  ```sql
  SELECT * FROM user_limits WHERE user_id = 'your-user-id';
  ```

---

**Last Updated**: January 21, 2026 1:00 PM PST
