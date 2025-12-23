# ElevenLabs API Key Management System

Complete guide for managing multiple ElevenLabs API keys with automatic rotation and usage tracking.

## Overview

The backend automatically manages multiple ElevenLabs API keys with:
- **Automatic rotation** when a key hits its character limit
- **Usage tracking** per key in Supabase
- **Health monitoring** via API endpoint
- **Seamless failover** when keys are exhausted or rate limited

```
iOS App → Backend → ElevenLabs Key Manager → Best Available Key
                         ↓
                    Supabase (tracking)
```

## Setup

### 1. Add Keys to .env.local

Store multiple keys as comma-separated values (with or without spaces):

```bash
# .env.local
ELEVENLABS_API_KEYS=sk_key1,sk_key2,sk_key3,sk_key4,sk_key5
```

You can also format with spaces for readability:

```bash
ELEVENLABS_API_KEYS=sk_key1, sk_key2, sk_key3, sk_key4, sk_key5
```

### 2. Run Database Migration

Run the SQL migration in Supabase SQL Editor:

```bash
# Copy contents of:
backend/supabase/migrations/002_elevenlabs_key_tracking.sql
```

Or directly:

```sql
-- See full SQL in backend/supabase/migrations/002_elevenlabs_key_tracking.sql
CREATE TABLE elevenlabs_key_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  api_key_hash TEXT NOT NULL UNIQUE,
  short_key TEXT NOT NULL,
  character_count INT NOT NULL DEFAULT 0,
  character_limit INT NOT NULL DEFAULT 0,
  remaining_characters INT NOT NULL DEFAULT 0,
  usage_percentage DECIMAL(5,4) NOT NULL DEFAULT 0,
  is_over_limit BOOLEAN NOT NULL DEFAULT false,
  is_near_limit BOOLEAN NOT NULL DEFAULT false,
  next_reset_date TIMESTAMP NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_checked TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### 3. Deploy to Vercel

The key manager is automatically initialized when the backend starts:

```bash
vercel env add ELEVENLABS_API_KEYS
# Paste your comma-separated keys
vercel deploy
```

## How It Works

### Automatic Key Selection

The system automatically selects the best available key:

1. **First Request**: Uses the first key
2. **Check Usage**: Fetches subscription info from ElevenLabs API
3. **Track Usage**: Saves to Supabase `elevenlabs_key_usage` table
4. **Rotate on Limit**: When a key hits 100% usage, rotates to next key
5. **Preemptive Warning**: Logs warning at 80% usage

### Key Status Tracking

Each key has these tracked metrics:

- `character_count`: Characters used this billing period
- `character_limit`: Total character limit for the key
- `remaining_characters`: Characters left
- `usage_percentage`: 0.0 to 1.0 (0% to 100%)
- `is_over_limit`: True when >= 100% usage
- `is_near_limit`: True when >= 80% usage
- `status`: `'active' | 'exhausted' | 'rate_limited' | 'invalid'`
- `next_reset_date`: When the character count resets

### Error Handling

The system automatically handles ElevenLabs API errors:

| HTTP Code | Error Type | Action |
|-----------|------------|--------|
| 200 | Success | Record usage, continue |
| 401 | Invalid Key | Mark as invalid, rotate |
| 402 | Payment Required | Mark as exhausted, rotate |
| 403 | Quota Exceeded | Mark as exhausted, rotate |
| 429 | Rate Limited | Mark as rate limited (60s cooldown), rotate |

## Monitoring

### 1. API Endpoint

Check key health via the monitoring endpoint:

```bash
GET /api/elevenlabs-status

# Response:
{
  "totalKeys": 8,
  "activeKeys": 6,
  "exhaustedKeys": 2,
  "nearLimitKeys": 1,
  "totalRemainingCharacters": 450000,
  "keys": [
    {
      "shortKey": "sk_6c036526...d452b",
      "status": "active",
      "characterCount": 5420,
      "characterLimit": 100000,
      "remainingCharacters": 94580,
      "usagePercentage": 5,
      "isOverLimit": false,
      "isNearLimit": false,
      "nextResetDate": "2025-02-01T00:00:00.000Z"
    },
    // ... more keys
  ]
}
```

### 2. Supabase Query

Query the tracking table directly:

```sql
-- View all keys with health status
SELECT * FROM elevenlabs_key_health
ORDER BY usage_percent ASC;

-- Find exhausted keys
SELECT short_key, remaining_characters, next_reset_date
FROM elevenlabs_key_usage
WHERE is_over_limit = true;

-- Find keys near limit (>= 80%)
SELECT short_key, usage_percentage, remaining_characters
FROM elevenlabs_key_usage
WHERE is_near_limit = true AND NOT is_over_limit
ORDER BY usage_percentage DESC;

-- Total remaining capacity across all keys
SELECT SUM(remaining_characters) AS total_remaining
FROM elevenlabs_key_usage
WHERE status = 'active' AND NOT is_over_limit;
```

### 3. Console Logs

The backend logs all key operations:

```bash
✅ Loaded 8 ElevenLabs API keys
✅ Using key sk_6c036526...d452b (94,580 chars remaining)
⚠️ Key sk_4b74d051...c99ae near limit: 15,234 chars remaining (84.8%)
🚫 Key sk_83f01b6e...da7a3 exhausted - rotating to next key
⏳ Rate limited: sk_8a8309fc...5d18 - rotating to next key
🔄 Rotated to key index 3
```

## Usage in Code

### In Next.js API Route

```typescript
import { elevenLabsKeyManager } from '../../lib/elevenlabs-key-manager'

export default async function handler(req, res) {
  try {
    // Get best available key
    const apiKey = await elevenLabsKeyManager.getAvailableKey()

    // Make ElevenLabs API call
    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/...', {
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: "Hello world" })
    })

    // Handle errors (automatic rotation)
    if (!response.ok) {
      await elevenLabsKeyManager.handleAPIError(response.status, apiKey)

      if (response.status === 429 || response.status === 402) {
        // Retry with next key
        const newKey = await elevenLabsKeyManager.getAvailableKey()
        // ... retry request
      }
    }

    return res.status(200).json({ success: true })

  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
}
```

## Free Tier Limits

Your 8 free keys each have these limits:

| Metric | Per Key | Total (8 keys) |
|--------|---------|----------------|
| Characters/month | 10,000 | 80,000 |
| Resets | Monthly | Monthly |

### Cost Calculation

Assuming average TTS usage:

- 1 message ≈ 200 characters
- 1 key = 10,000 chars = **50 messages**
- 8 keys = 80,000 chars = **400 messages/month**

When keys are exhausted, the system will throw:
```
Error: All ElevenLabs API keys are exhausted or rate limited
```

## Troubleshooting

### All Keys Exhausted

If all keys hit their limits:

```bash
# Check status
curl https://your-backend.vercel.app/api/elevenlabs-status

# Wait for monthly reset or add more keys
vercel env add ELEVENLABS_API_KEYS
# Append new keys: existing_keys,new_key1,new_key2
```

### Key Not Rotating

1. Check Supabase table exists:
   ```sql
   SELECT * FROM elevenlabs_key_usage;
   ```

2. Verify keys are valid:
   ```bash
   curl https://api.elevenlabs.io/v1/user/subscription \
     -H "xi-api-key: YOUR_KEY"
   ```

3. Check backend logs in Vercel dashboard

### Invalid Key Format

Keys must be comma-separated without quotes:

```bash
# ✅ Correct
ELEVENLABS_API_KEYS=sk_key1,sk_key2,sk_key3

# ❌ Wrong (quotes)
ELEVENLABS_API_KEYS="sk_key1","sk_key2","sk_key3"

# ✅ Also correct (spaces OK)
ELEVENLABS_API_KEYS=sk_key1, sk_key2, sk_key3
```

## Security

The system protects your keys:

1. **Never logs full keys** - only shows first 12 + last 8 chars
2. **Hashes keys** in Supabase using simple hash function
3. **Stored in env vars** - not in code or Git
4. **Service role key** required for Supabase access

## Syncing with iOS

The iOS app (`ElevenLabsKeyManager.swift`) also tracks usage per user:

- **Free tier users**: 3 voice messages max (uses shared backend keys)
- **Paid users**: Unlimited (uses their own API key)

Backend automatically handles both:

```typescript
// Backend checks if user has own key
if (user.hasOwnAPIKey) {
  return user.userElevenLabsKey  // Use their key
} else {
  return await elevenLabsKeyManager.getAvailableKey()  // Use shared pool
}
```

## Future Enhancements

1. **Redis caching** for key status (reduce API calls)
2. **Predictive rotation** based on usage patterns
3. **Auto-refill** from billing API when keys reset
4. **Slack alerts** when all keys near limit
5. **A/B testing** different keys for quality
6. **Geographic routing** based on user location

## Summary

Your backend now has:

✅ **8 ElevenLabs keys** with automatic rotation
✅ **80,000 characters/month** total capacity
✅ **Smart failover** when keys are exhausted
✅ **Real-time tracking** in Supabase
✅ **Health monitoring** via API endpoint
✅ **Production-ready** error handling

No more manual key management. Set it and forget it!
