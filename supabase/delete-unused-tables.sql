-- Delete unused analytics aggregation tables
-- These tables were never populated and have no references in the codebase
-- Run this in your Supabase SQL Editor

DROP TABLE IF EXISTS public.ai_error_frequency;
DROP TABLE IF EXISTS public.ai_errors_detailed;
DROP TABLE IF EXISTS public.ai_streaming_issues;

-- Confirmation message
SELECT 'Unused analytics tables deleted successfully' as message;
