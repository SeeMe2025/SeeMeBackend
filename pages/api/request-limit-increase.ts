import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Check if user already has a pending request
    const { data: existingRequests, error: checkError } = await supabase
      .from('limit_increase_requests')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      console.error('Error checking existing requests:', checkError);
      return res.status(500).json({ error: 'Failed to check existing requests' });
    }

    if (existingRequests) {
      return res.status(400).json({ 
        error: 'You already have a pending request',
        existingRequest: existingRequests 
      });
    }

    // Get user's current data
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('name, age, created_at')
      .eq('id', userId)
      .single();

    if (userError) {
      console.error('Error fetching user data:', userError);
      return res.status(500).json({ error: 'Failed to fetch user data' });
    }

    // Get user's current usage
    const { data: usageData, error: usageError } = await supabase
      .from('ai_usage_tracking')
      .select('text_sessions_count, voice_sessions_count, image_generations_count, custom_text_limit')
      .eq('user_id', userId)
      .single();

    if (usageError) {
      console.error('Error fetching usage data:', usageError);
      return res.status(500).json({ error: 'Failed to fetch usage data' });
    }

    const currentLimit = usageData.custom_text_limit || 20;

    // Create the request
    const { data: newRequest, error: insertError } = await supabase
      .from('limit_increase_requests')
      .insert({
        user_id: userId,
        user_name: userData.name,
        user_age: userData.age,
        text_usage: usageData.text_sessions_count || 0,
        voice_usage: usageData.voice_sessions_count || 0,
        image_usage: usageData.image_generations_count || 0,
        current_text_limit: currentLimit,
        account_created_at: userData.created_at,
        status: 'pending'
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error creating request:', insertError);
      return res.status(500).json({ error: 'Failed to create request' });
    }

    return res.status(200).json({ 
      success: true, 
      request: newRequest,
      message: 'Your request has been submitted. We will review it shortly.' 
    });

  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
