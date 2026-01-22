-- Ban System Migration
-- Creates tables for banning users, devices, and IP addresses
-- Note: device_tracking table already exists, so we skip creating it

-- ============================================
-- 2. BANNED USERS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS banned_users (
  user_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  banned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  banned_by TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_banned_users_banned_at ON banned_users(banned_at DESC);

COMMENT ON TABLE banned_users IS 'Users who have been banned from the platform';
COMMENT ON COLUMN banned_users.reason IS 'Reason for the ban';
COMMENT ON COLUMN banned_users.banned_by IS 'Admin who issued the ban';

-- ============================================
-- 3. BANNED IPS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS banned_ips (
  ip_address TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  banned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  banned_by TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_banned_ips_banned_at ON banned_ips(banned_at DESC);

COMMENT ON TABLE banned_ips IS 'IP addresses that have been banned';
COMMENT ON COLUMN banned_ips.reason IS 'Reason for the ban';

-- ============================================
-- 4. BANNED DEVICES TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS banned_devices (
  device_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  banned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  banned_by TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_banned_devices_banned_at ON banned_devices(banned_at DESC);

COMMENT ON TABLE banned_devices IS 'Devices that have been banned';
COMMENT ON COLUMN banned_devices.reason IS 'Reason for the ban';

-- ============================================
-- 5. BANNED ACCESS ATTEMPTS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS banned_access_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT,
  device_id TEXT,
  ip_address TEXT,
  ban_type TEXT NOT NULL,
  attempted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  request_details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_banned_attempts_user_id ON banned_access_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_banned_attempts_device_id ON banned_access_attempts(device_id);
CREATE INDEX IF NOT EXISTS idx_banned_attempts_ip_address ON banned_access_attempts(ip_address);
CREATE INDEX IF NOT EXISTS idx_banned_attempts_attempted_at ON banned_access_attempts(attempted_at DESC);

COMMENT ON TABLE banned_access_attempts IS 'Logs access attempts by banned users/devices/IPs';
COMMENT ON COLUMN banned_access_attempts.ban_type IS 'Type of ban that blocked access (user, device, ip)';

-- ============================================
-- 6. HELPER FUNCTIONS
-- ============================================

-- Function to check if a user is banned
CREATE OR REPLACE FUNCTION is_user_banned(p_user_id TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM banned_users WHERE user_id = p_user_id);
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to check if a device is banned
CREATE OR REPLACE FUNCTION is_device_banned(p_device_id TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM banned_devices WHERE device_id = p_device_id);
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to check if an IP is banned
CREATE OR REPLACE FUNCTION is_ip_banned(p_ip_address TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM banned_ips WHERE ip_address = p_ip_address);
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to get all ban information for a user
CREATE OR REPLACE FUNCTION get_user_ban_info(p_user_id TEXT)
RETURNS TABLE (
  user_banned BOOLEAN,
  device_ids_banned TEXT[],
  ip_addresses_banned TEXT[],
  ban_reason TEXT,
  banned_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    EXISTS (SELECT 1 FROM banned_users WHERE user_id = p_user_id) as user_banned,
    ARRAY(
      SELECT DISTINCT bd.device_id 
      FROM device_tracking dt
      JOIN banned_devices bd ON bd.device_id = dt.device_id
      WHERE dt.user_id = p_user_id
    ) as device_ids_banned,
    ARRAY(
      SELECT DISTINCT bi.ip_address 
      FROM device_tracking dt
      JOIN banned_ips bi ON bi.ip_address = dt.ip_address
      WHERE dt.user_id = p_user_id
    ) as ip_addresses_banned,
    bu.reason as ban_reason,
    bu.banned_at as banned_at
  FROM banned_users bu
  WHERE bu.user_id = p_user_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to unban a user (removes user, device, and IP bans)
CREATE OR REPLACE FUNCTION unban_user(p_user_id TEXT)
RETURNS VOID AS $$
BEGIN
  -- Get all devices and IPs associated with this user
  DELETE FROM banned_ips 
  WHERE ip_address IN (
    SELECT DISTINCT ip_address 
    FROM device_tracking 
    WHERE user_id = p_user_id
  );
  
  DELETE FROM banned_devices 
  WHERE device_id IN (
    SELECT DISTINCT device_id 
    FROM device_tracking 
    WHERE user_id = p_user_id
  );
  
  DELETE FROM banned_users WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 7. VIEW FOR BAN DASHBOARD
-- ============================================

CREATE OR REPLACE VIEW banned_users_detailed AS
SELECT 
  bu.user_id,
  u.email,
  bu.reason,
  bu.banned_at,
  bu.banned_by,
  bu.notes,
  COALESCE(device_count.count, 0) as banned_devices_count,
  COALESCE(ip_count.count, 0) as banned_ips_count,
  COALESCE(attempt_count.count, 0) as access_attempts_since_ban
FROM banned_users bu
LEFT JOIN auth.users u ON u.id::TEXT = bu.user_id
LEFT JOIN (
  SELECT dt.user_id, COUNT(DISTINCT bd.device_id) as count
  FROM device_tracking dt
  JOIN banned_devices bd ON bd.device_id = dt.device_id
  GROUP BY dt.user_id
) device_count ON device_count.user_id = bu.user_id
LEFT JOIN (
  SELECT dt.user_id, COUNT(DISTINCT bi.ip_address) as count
  FROM device_tracking dt
  JOIN banned_ips bi ON bi.ip_address = dt.ip_address
  GROUP BY dt.user_id
) ip_count ON ip_count.user_id = bu.user_id
LEFT JOIN (
  SELECT user_id, COUNT(*) as count
  FROM banned_access_attempts
  WHERE attempted_at > (SELECT banned_at FROM banned_users WHERE user_id = banned_access_attempts.user_id)
  GROUP BY user_id
) attempt_count ON attempt_count.user_id = bu.user_id
ORDER BY bu.banned_at DESC;

COMMENT ON VIEW banned_users_detailed IS 'Detailed view of banned users with associated device and IP counts';

-- ============================================
-- 8. ENABLE RLS (Row Level Security)
-- ============================================

ALTER TABLE banned_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE banned_ips ENABLE ROW LEVEL SECURITY;
ALTER TABLE banned_devices ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (for API endpoints)
CREATE POLICY "Service role has full access to banned_users" ON banned_users
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role has full access to banned_ips" ON banned_ips
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role has full access to banned_devices" ON banned_devices
  FOR ALL USING (auth.role() = 'service_role');
