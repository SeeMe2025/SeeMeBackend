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
    const { userId, reason } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Get user's device tracking data to ban IP and device
    const { data: deviceData, error: deviceError } = await supabase
      .from('device_tracking')
      .select('ip_address, device_id')
      .eq('user_id', userId);

    if (deviceError) {
      console.error('Error fetching device data:', deviceError);
      return res.status(500).json({ error: 'Failed to fetch device data' });
    }

    const bannedAt = new Date().toISOString();
    const banReason = reason || 'Banned by admin';

    // Ban all IPs associated with this user
    const uniqueIPs = [...new Set(deviceData?.map(d => d.ip_address).filter(Boolean) || [])];
    if (uniqueIPs.length > 0) {
      const ipBans = uniqueIPs.map(ip => ({
        ip_address: ip,
        reason: banReason,
        banned_at: bannedAt
      }));

      const { error: ipBanError } = await supabase
        .from('banned_ips')
        .upsert(ipBans, { onConflict: 'ip_address' });

      if (ipBanError) {
        console.error('Error banning IPs:', ipBanError);
      }
    }

    // Ban all devices associated with this user
    const uniqueDevices = [...new Set(deviceData?.map(d => d.device_id).filter(Boolean) || [])];
    if (uniqueDevices.length > 0) {
      const deviceBans = uniqueDevices.map(deviceId => ({
        device_id: deviceId,
        reason: banReason,
        banned_at: bannedAt
      }));

      const { error: deviceBanError } = await supabase
        .from('banned_devices')
        .upsert(deviceBans, { onConflict: 'device_id' });

      if (deviceBanError) {
        console.error('Error banning devices:', deviceBanError);
      }
    }

    // Ban the user ID
    const { error: userBanError } = await supabase
      .from('banned_users')
      .upsert({
        user_id: userId,
        reason: banReason,
        banned_at: bannedAt
      }, { onConflict: 'user_id' });

    if (userBanError) {
      console.error('Error banning user:', userBanError);
      return res.status(500).json({ error: 'Failed to ban user' });
    }

    return res.status(200).json({
      success: true,
      message: 'User banned successfully',
      banned: {
        userId,
        ips: uniqueIPs.length,
        devices: uniqueDevices.length
      }
    });

  } catch (error) {
    console.error('Ban user error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
