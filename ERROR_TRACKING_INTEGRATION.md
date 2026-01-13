# AI Error Tracking & Dashboard Integration

This document explains how errors flow from the Next.js backend to the Swift iOS app and into Supabase for dashboard visibility.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Error Flow                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Backend Error Occurs                                        │
│     ├─ Timeout (300s limit exceeded)                           │
│     ├─ OpenAI/Anthropic API error                              │
│     ├─ Network failure                                          │
│     ├─ Stream abort (client disconnect)                        │
│     └─ Rate limit exceeded                                      │
│                                                                 │
│  2. Backend Logs to Supabase                                    │
│     ├─ Detailed error context                                  │
│     ├─ Stack trace (first 500 chars)                           │
│     ├─ Request metadata                                         │
│     └─ Session/coach context                                    │
│                                                                 │
│  3. Backend Sends Structured Error to Swift App                │
│     ├─ Error message                                            │
│     ├─ Error type & code                                        │
│     ├─ Provider/model info                                      │
│     ├─ Request ID for correlation                              │
│     └─ Full context for debugging                              │
│                                                                 │
│  4. Swift App Receives Error via SSE Stream                     │
│     ├─ Parses structured JSON error                            │
│     ├─ Calls LoggingService.trackAIError()                     │
│     ├─ Shows user-friendly error message                       │
│     └─ Logs to local console for debugging                     │
│                                                                 │
│  5. Dashboard Displays Error Analytics                          │
│     ├─ Error frequency by type                                 │
│     ├─ Affected users count                                    │
│     ├─ Provider/model breakdown                                │
│     ├─ Stack traces for debugging                              │
│     └─ Streaming issues tracking                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Backend Error Response Structure

When an error occurs, the backend sends this structured response via SSE:

```typescript
{
  error: "Stream timeout: Response took too long",
  errorType: "Error",
  errorCode: "STREAM_TIMEOUT",
  provider: "openai",
  model: "gpt-5.1",
  promptType: "conversation",
  requestId: "req_1736445600000_abc123",
  timestamp: "2026-01-09T16:00:00.000Z",
  context: {
    messageLength: 150,
    previousMessagesCount: 12,
    hasTools: false,
    userId: "user-uuid-here",
    sessionId: "session-uuid-here",
    coachId: "coach-uuid-here",
    isVoiceMode: true
  }
}
```

---

## Swift App Integration

### How to Parse and Log Errors

In your AI service (e.g., `OpenAIService.swift`, `TextAIService.swift`), when parsing SSE events:

```swift
// In SSE event parsing
if let errorData = try? JSONDecoder().decode(AIErrorResponse.self, from: data) {
    // Log to LoggingService
    LoggingService.shared.trackAIError(
        provider: errorData.provider,
        promptType: errorData.promptType,
        errorType: errorData.errorType,
        errorMessage: errorData.error,
        requestId: errorData.requestId,
        userId: errorData.context.userId,
        isVoiceMode: errorData.context.isVoiceMode,
        hasElevenLabsKey: false // Set based on your context
    )
    
    // Show user-friendly error
    throw AIError.backendError(errorData.error)
}
```

### Error Response Model

Add this to your Swift models:

```swift
struct AIErrorResponse: Codable {
    let error: String
    let errorType: String
    let errorCode: String
    let provider: String
    let model: String
    let promptType: String
    let requestId: String
    let timestamp: String
    let context: ErrorContext
}

struct ErrorContext: Codable {
    let messageLength: Int
    let previousMessagesCount: Int
    let hasTools: Bool
    let userId: String
    let sessionId: String?
    let coachId: String?
    let isVoiceMode: Bool
}
```

---

## Supabase Schema

### ai_usage Table (Enhanced)

```sql
CREATE TABLE ai_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  prompt_type TEXT,
  event_type TEXT NOT NULL, -- 'request', 'response', 'error'
  
  -- Request data
  message_length INT,
  request_id TEXT NOT NULL,
  
  -- Response data
  response_length INT,
  tokens_used INT,
  latency_ms INT,
  from_cache BOOLEAN DEFAULT false,
  stream_aborted BOOLEAN DEFAULT false,
  
  -- Error data (ENHANCED)
  error_type TEXT,
  error_code TEXT,           -- NEW: Specific error code
  error_message TEXT,
  stack_trace TEXT,          -- NEW: Stack trace for debugging
  
  -- Context
  session_id UUID,
  coach_id UUID,
  feature_name TEXT,
  
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Dashboard Views

### 1. Error Frequency Analysis

```sql
CREATE VIEW ai_error_frequency AS
SELECT
  error_type,
  error_code,
  provider,
  model,
  COUNT(*) as error_count,
  COUNT(DISTINCT user_id) as affected_users,
  MAX(created_at) as last_occurrence,
  MIN(created_at) as first_occurrence
FROM ai_usage
WHERE event_type = 'error'
GROUP BY error_type, error_code, provider, model
ORDER BY error_count DESC;
```

**Use Case**: See which errors are most common and how many users are affected.

---

### 2. Detailed Error View

```sql
CREATE VIEW ai_errors_detailed AS
SELECT
  id,
  user_id,
  provider,
  model,
  prompt_type,
  error_type,
  error_code,
  error_message,
  stack_trace,
  request_id,
  session_id,
  coach_id,
  feature_name,
  created_at
FROM ai_usage
WHERE event_type = 'error'
ORDER BY created_at DESC;
```

**Use Case**: Drill down into specific errors with full context and stack traces.

---

### 3. Streaming Issues Tracker

```sql
CREATE VIEW ai_streaming_issues AS
SELECT
  user_id,
  provider,
  model,
  prompt_type,
  request_id,
  latency_ms,
  stream_aborted,
  created_at
FROM ai_usage
WHERE event_type = 'response' AND stream_aborted = true
ORDER BY created_at DESC;
```

**Use Case**: Track when streams are aborted due to client disconnects or timeouts.

---

## Common Error Types

| Error Type | Error Code | Cause | Solution |
|------------|-----------|-------|----------|
| `Error` | `STREAM_TIMEOUT` | Response took >280s | Check OpenAI/Anthropic status, reduce context size |
| `Error` | `ECONNRESET` | Network connection lost | Retry logic, check network stability |
| `APIError` | `rate_limit_exceeded` | Too many requests | Implement backoff, check rate limits |
| `APIError` | `invalid_api_key` | API key issue | Verify API keys in environment |
| `Error` | `UNKNOWN` | Unhandled error | Check stack_trace in dashboard |

---

## Testing Error Tracking

### 1. Simulate Timeout Error

```bash
# In backend, temporarily set streamTimeout to 5 seconds
const streamTimeout = 5000 // Will timeout quickly for testing
```

### 2. Check Supabase

```sql
-- View recent errors
SELECT * FROM ai_errors_detailed 
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;

-- Check error frequency
SELECT * FROM ai_error_frequency;

-- Check streaming issues
SELECT * FROM ai_streaming_issues
WHERE created_at > NOW() - INTERVAL '1 day';
```

### 3. Verify Swift App Logging

Check Xcode console for:
```
📊 [15s] ai_error from openai: STREAM_TIMEOUT [text]
```

---

## Dashboard Queries for Analytics

### Error Rate Over Time

```sql
SELECT
  DATE_TRUNC('hour', created_at) as hour,
  COUNT(*) as error_count,
  COUNT(DISTINCT user_id) as affected_users
FROM ai_usage
WHERE event_type = 'error'
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour DESC;
```

### Success Rate by Provider

```sql
SELECT
  provider,
  COUNT(*) FILTER (WHERE event_type = 'response') as successful_requests,
  COUNT(*) FILTER (WHERE event_type = 'error') as failed_requests,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE event_type = 'response') / 
    NULLIF(COUNT(*), 0), 
    2
  ) as success_rate_percent
FROM ai_usage
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY provider;
```

### Average Latency by Model

```sql
SELECT
  provider,
  model,
  COUNT(*) as request_count,
  AVG(latency_ms) as avg_latency_ms,
  MAX(latency_ms) as max_latency_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95_latency_ms
FROM ai_usage
WHERE event_type = 'response'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY provider, model
ORDER BY avg_latency_ms DESC;
```

---

## Migration Instructions

### 1. Run Migration

```bash
cd /Users/sankritya/All\ Web\ Dev\ Projects/seeme-backend
npx supabase migration up
```

Or manually run:
```bash
psql $DATABASE_URL -f supabase/migrations/004_enhance_ai_error_tracking.sql
```

### 2. Verify Schema

```sql
-- Check new columns exist
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'ai_usage' 
  AND column_name IN ('error_code', 'stack_trace', 'stream_aborted');
```

### 3. Test Error Logging

Deploy backend and trigger an error, then check:
```sql
SELECT error_code, stack_trace, created_at 
FROM ai_usage 
WHERE event_type = 'error' 
ORDER BY created_at DESC 
LIMIT 5;
```

---

## Next Steps

1. **Deploy Backend**: Push changes to Vercel
2. **Run Migration**: Execute `004_enhance_ai_error_tracking.sql` on Supabase
3. **Update Swift App**: Add error parsing logic to AI services
4. **Build Dashboard**: Create views using the SQL queries above
5. **Monitor**: Watch `ai_errors_detailed` view for issues

---

## Support

For issues with error tracking:
- Check backend logs in Vercel
- Verify Supabase connection
- Ensure Swift app is calling `LoggingService.trackAIError()`
- Review dashboard queries for data visibility
