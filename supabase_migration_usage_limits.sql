-- Create usage_limits table for rate limiting
CREATE TABLE IF NOT EXISTS public.usage_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT UNIQUE NOT NULL,
    voice_sessions_count INTEGER DEFAULT 0 NOT NULL,
    text_sessions_count INTEGER DEFAULT 0 NOT NULL,
    has_elevenlabs_key BOOLEAN DEFAULT false NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Create index on device_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_usage_limits_device_id ON public.usage_limits(device_id);

-- Enable Row Level Security
ALTER TABLE public.usage_limits ENABLE ROW LEVEL SECURITY;

-- Create policy to allow all operations (you can restrict this later)
CREATE POLICY "Allow all operations on usage_limits" ON public.usage_limits
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updated_at
DROP TRIGGER IF EXISTS update_usage_limits_updated_at ON public.usage_limits;
CREATE TRIGGER update_usage_limits_updated_at
    BEFORE UPDATE ON public.usage_limits
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();
