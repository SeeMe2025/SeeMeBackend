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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId } = req.query;

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Check if user is banned
    const { data: userBan, error: userBanError } = await supabase
      .from('banned_users')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (userBanError && userBanError.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('Error checking user ban:', userBanError);
      return res.status(500).json({ error: 'Failed to check ban status', details: userBanError.message });
    }

    // Get device tracking data
    const { data: deviceData, error: deviceError } = await supabase
      .from('device_tracking')
      .select('ip_address, device_id')
      .eq('user_id', userId);

    if (deviceError) {
      console.error('Error fetching device data:', deviceError);
    }

    const uniqueIPs = [...new Set(deviceData?.map(d => d.ip_address).filter(Boolean) || [])];
    const uniqueDevices = [...new Set(deviceData?.map(d => d.device_id).filter(Boolean) || [])];

    // Check banned devices
    let bannedDevices: string[] = [];
    if (uniqueDevices.length > 0) {
      const { data: deviceBans } = await supabase
        .from('banned_devices')
        .select('device_id')
        .in('device_id', uniqueDevices);
      
      bannedDevices = deviceBans?.map(d => d.device_id) || [];
    }

    // Check banned IPs
    let bannedIPs: string[] = [];
    if (uniqueIPs.length > 0) {
      const { data: ipBans } = await supabase
        .from('banned_ips')
        .select('ip_address')
        .in('ip_address', uniqueIPs);
      
      bannedIPs = ipBans?.map(d => d.ip_address) || [];
    }

    const isBanned = !!userBan || bannedDevices.length > 0 || bannedIPs.length > 0;

    return res.status(200).json({
      isBanned,
      banDetails: userBan ? {
        reason: userBan.reason,
        bannedAt: userBan.banned_at,
        bannedBy: userBan.banned_by,
        notes: userBan.notes
      } : null,
      bannedDevices,
      bannedIPs,
      totalDevices: uniqueDevices.length,
      totalIPs: uniqueIPs.length
    });

  } catch (error: any) {
    console.error('Check ban status error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error?.message });
  }
}
