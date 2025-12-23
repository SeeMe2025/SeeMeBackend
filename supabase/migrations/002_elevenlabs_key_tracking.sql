-- ElevenLabs API Key Usage Tracking Table
-- Tracks usage per key to enable automatic rotation when keys hit their limits

CREATE TABLE IF NOT EXISTS elevenlabs_key_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  api_key_hash TEXT NOT NULL UNIQUE, -- Hashed key for privacy
  short_key TEXT NOT NULL, -- First 12 + last 8 chars for display
  character_count INT NOT NULL DEFAULT 0,
  character_limit INT NOT NULL DEFAULT 0,
  remaining_characters INT NOT NULL DEFAULT 0,
  usage_percentage DECIMAL(5,4) NOT NULL DEFAULT 0, -- 0.0 to 1.0
  is_over_limit BOOLEAN NOT NULL DEFAULT false,
  is_near_limit BOOLEAN NOT NULL DEFAULT false, -- >= 80% usage
  next_reset_date TIMESTAMP NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'exhausted', 'rate_limited', 'invalid'
  last_checked TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX idx_elevenlabs_key_hash ON elevenlabs_key_usage(api_key_hash);
CREATE INDEX idx_elevenlabs_status ON elevenlabs_key_usage(status);
CREATE INDEX idx_elevenlabs_usage ON elevenlabs_key_usage(is_over_limit, is_near_limit);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_elevenlabs_key_usage_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
CREATE TRIGGER trigger_update_elevenlabs_key_usage_updated_at
  BEFORE UPDATE ON elevenlabs_key_usage
  FOR EACH ROW
  EXECUTE FUNCTION update_elevenlabs_key_usage_updated_at();

-- View for monitoring key health
CREATE OR REPLACE VIEW elevenlabs_key_health AS
SELECT
  short_key,
  character_count,
  character_limit,
  remaining_characters,
  ROUND((usage_percentage * 100)::numeric, 2) AS usage_percent,
  is_over_limit,
  is_near_limit,
  status,
  next_reset_date,
  last_checked,
  CASE
    WHEN is_over_limit THEN '🚫 Exhausted'
    WHEN is_near_limit THEN '⚠️ Near Limit'
    WHEN status = 'rate_limited' THEN '⏳ Rate Limited'
    WHEN status = 'invalid' THEN '❌ Invalid'
    ELSE '✅ Available'
  END AS health_status
FROM elevenlabs_key_usage
ORDER BY is_over_limit ASC, usage_percentage ASC;
