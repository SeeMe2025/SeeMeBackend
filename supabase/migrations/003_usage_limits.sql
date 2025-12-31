-- Create usage_limits table for rate limiting
CREATE TABLE IF NOT EXISTS usage_limits (
  device_id TEXT PRIMARY KEY,
  voice_sessions_count INT DEFAULT 0 NOT NULL,
  text_sessions_count INT DEFAULT 0 NOT NULL,
  has_elevenlabs_key BOOLEAN DEFAULT false NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_usage_limits_device_id ON usage_limits(device_id);

-- Add RLS policies (privacy-first - no auth required)
ALTER TABLE usage_limits ENABLE ROW LEVEL SECURITY;

-- Allow public read/write access (device_id acts as identifier)
CREATE POLICY "Public access to usage_limits"
  ON usage_limits
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Create function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_usage_limits_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for auto-updating updated_at
CREATE TRIGGER usage_limits_updated_at
  BEFORE UPDATE ON usage_limits
  FOR EACH ROW
  EXECUTE FUNCTION update_usage_limits_updated_at();
