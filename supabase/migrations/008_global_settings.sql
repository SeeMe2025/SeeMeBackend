-- Global settings table for configurable rate limits
CREATE TABLE IF NOT EXISTS global_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default global limits
INSERT INTO global_settings (key, value, description) VALUES
  ('default_text_limit', '100', 'Default text messages limit per day'),
  ('default_voice_limit', '3', 'Default voice messages limit per day')
ON CONFLICT (key) DO NOTHING;

-- Enable RLS
ALTER TABLE global_settings ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role can manage global_settings"
  ON global_settings
  FOR ALL
  USING (true)
  WITH CHECK (true);
