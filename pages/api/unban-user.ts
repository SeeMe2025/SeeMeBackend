import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    console.log('Unban request for user:', userId);

    // Get user's device tracking data to unban IP and device
    const { data: deviceData, error: deviceError } = await supabase
      .from('device_tracking')
      .select('ip_address, device_id')
      .eq('user_id', userId);

    if (deviceError) {
      console.error('Error fetching device data:', deviceError);
      return res.status(500).json({ error: 'Failed to fetch device data', details: deviceError.message });
    }

    console.log('Found device data:', deviceData?.length || 0, 'records');

    // Unban all IPs associated with this user
    const uniqueIPs = [...new Set(deviceData?.map(d => d.ip_address).filter(Boolean) || [])];
    if (uniqueIPs.length > 0) {
      console.log('Unbanning IPs:', uniqueIPs);
      
      const { error: ipUnbanError } = await supabase
        .from('banned_ips')
        .delete()
        .in('ip_address', uniqueIPs);

      if (ipUnbanError) {
        console.error('Error unbanning IPs:', ipUnbanError);
        return res.status(500).json({ error: 'Failed to unban IPs', details: ipUnbanError.message });
      }
    }

    // Unban all devices associated with this user
    const uniqueDevices = [...new Set(deviceData?.map(d => d.device_id).filter(Boolean) || [])];
    if (uniqueDevices.length > 0) {
      console.log('Unbanning devices:', uniqueDevices);
      
      const { error: deviceUnbanError } = await supabase
        .from('banned_devices')
        .delete()
        .in('device_id', uniqueDevices);

      if (deviceUnbanError) {
        console.error('Error unbanning devices:', deviceUnbanError);
        return res.status(500).json({ error: 'Failed to unban devices', details: deviceUnbanError.message });
      }
    }

    // Unban the user ID
    console.log('Unbanning user ID:', userId);
    const { error: userUnbanError } = await supabase
      .from('banned_users')
      .delete()
      .eq('user_id', userId);

    if (userUnbanError) {
      console.error('Error unbanning user:', userUnbanError);
      return res.status(500).json({ error: 'Failed to unban user', details: userUnbanError.message });
    }

    console.log('Unban successful');
    return res.status(200).json({
      success: true,
      message: 'User unbanned successfully',
      unbanned: {
        userId,
        ips: uniqueIPs.length,
        devices: uniqueDevices.length
      }
    });

  } catch (error: any) {
    console.error('Unban user error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error?.message });
  }
}
