-- Add custom voice limit support to user_limits table
-- This allows dashboard admins to set custom voice limits per user
-- Voice limits apply to both ElevenLabs and OpenAI TTS endpoints

-- Add custom_voice_limit column to user_limits table
ALTER TABLE user_limits 
ADD COLUMN IF NOT EXISTS custom_voice_limit INT;

-- Create index for faster lookups on custom voice limits
CREATE INDEX IF NOT EXISTS idx_user_limits_custom_voice_limit 
ON user_limits(custom_voice_limit) 
WHERE custom_voice_limit IS NOT NULL;

-- Update comments
COMMENT ON COLUMN user_limits.custom_rate_limit IS 'Custom text message limit (overrides default 20)';
COMMENT ON COLUMN user_limits.custom_voice_limit IS 'Custom voice message limit (overrides default 3)';
COMMENT ON TABLE user_limits IS 'User-level custom limits, flagging, and rate limit overrides';
