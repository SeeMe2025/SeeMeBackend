import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return handleGet(req, res);
  } else if (req.method === 'POST') {
    return handlePost(req, res);
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { status } = req.query;

    let query = supabase
      .from('limit_increase_requests')
      .select('*')
      .order('requested_at', { ascending: false });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching requests:', error);
      return res.status(500).json({ error: 'Failed to fetch requests' });
    }

    return res.status(200).json(data || []);
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { requestId, action, approvedLimit, notes, reviewedBy } = req.body;

    if (!requestId || !action) {
      return res.status(400).json({ error: 'requestId and action are required' });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }

    // Get the request
    const { data: request, error: fetchError } = await supabase
      .from('limit_increase_requests')
      .select('*')
      .eq('id', requestId)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request has already been reviewed' });
    }

    // Update the request status
    const updateData: any = {
      status: action === 'approve' ? 'approved' : 'rejected',
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewedBy || 'admin',
      notes: notes || null
    };

    if (action === 'approve' && approvedLimit) {
      updateData.approved_text_limit = approvedLimit;
    }

    const { error: updateError } = await supabase
      .from('limit_increase_requests')
      .update(updateData)
      .eq('id', requestId);

    if (updateError) {
      console.error('Error updating request:', updateError);
      return res.status(500).json({ error: 'Failed to update request' });
    }

    // If approved, update the user's custom limit
    if (action === 'approve' && approvedLimit) {
      const { error: limitError } = await supabase
        .from('ai_usage_tracking')
        .update({ custom_text_limit: approvedLimit })
        .eq('user_id', request.user_id);

      if (limitError) {
        console.error('Error updating user limit:', limitError);
        return res.status(500).json({ error: 'Failed to update user limit' });
      }
    }

    return res.status(200).json({ 
      success: true, 
      message: `Request ${action}d successfully` 
    });

  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
