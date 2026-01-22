-- Migration: Limit Increase Request System
-- Allows users to appeal for higher rate limits

CREATE TABLE IF NOT EXISTS limit_increase_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT,
    notes TEXT,
    current_text_limit INTEGER NOT NULL,
    requested_text_limit INTEGER,
    approved_text_limit INTEGER,
    
    -- User context at time of request
    user_name TEXT,
    user_age INTEGER,
    text_usage INTEGER NOT NULL,
    voice_usage INTEGER NOT NULL,
    image_usage INTEGER NOT NULL,
    account_created_at TIMESTAMPTZ,
    
    CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for quick lookups
CREATE INDEX idx_limit_requests_user_id ON limit_increase_requests(user_id);
CREATE INDEX idx_limit_requests_status ON limit_increase_requests(status);
CREATE INDEX idx_limit_requests_requested_at ON limit_increase_requests(requested_at DESC);

-- Enable RLS
ALTER TABLE limit_increase_requests ENABLE ROW LEVEL SECURITY;

-- Policy: Users can insert their own requests
CREATE POLICY "Users can create their own limit increase requests"
    ON limit_increase_requests
    FOR INSERT
    WITH CHECK (true);

-- Policy: Users can view their own requests
CREATE POLICY "Users can view their own limit increase requests"
    ON limit_increase_requests
    FOR SELECT
    USING (true);

-- Add comment
COMMENT ON TABLE limit_increase_requests IS 'Tracks user requests for increased rate limits with approval workflow';
