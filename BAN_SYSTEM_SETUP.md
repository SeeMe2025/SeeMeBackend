# Ban System Setup Guide

## Overview
The ban system allows you to ban users by their user ID, which automatically bans all associated device IDs and IP addresses. This ensures comprehensive blocking across all user touchpoints.

## Database Tables Created

### 1. `banned_users`
- **Purpose**: Stores banned user IDs
- **Primary Key**: `user_id` (TEXT)
- **Columns**: `user_id`, `reason`, `banned_at`, `banned_by`, `notes`, `created_at`, `updated_at`

### 2. `banned_ips`
- **Purpose**: Stores banned IP addresses
- **Primary Key**: `ip_address` (TEXT)
- **Columns**: `ip_address`, `reason`, `banned_at`, `banned_by`, `notes`, `created_at`, `updated_at`

### 3. `banned_devices`
- **Purpose**: Stores banned device IDs
- **Primary Key**: `device_id` (TEXT)
- **Columns**: `device_id`, `reason`, `banned_at`, `banned_by`, `notes`, `created_at`, `updated_at`

### 4. `device_tracking` (Already Existed)
- **Purpose**: Tracks which devices and IPs are associated with each user
- **Columns**: `id`, `user_id` (UUID), `device_id`, `ip_address`, `first_seen_at`, `last_seen_at`, `created_at`

## How It Works

### Banning a User
When you ban a user via the dashboard:

1. **API Call**: The dashboard sends a POST request to `/api/ban-user` with:
   ```json
   {
     "userId": "user-uuid-here",
     "reason": "Optional ban reason"
   }
   ```

2. **Device Lookup**: The API queries `device_tracking` to find all devices and IPs associated with that user

3. **Comprehensive Ban**: The API creates ban records in:
   - `banned_users` - Bans the user ID
   - `banned_devices` - Bans all associated device IDs
   - `banned_ips` - Bans all associated IP addresses

4. **Result**: The user cannot access the app from any device or IP they've previously used

### Checking Ban Status
The system provides helper functions:
- `is_user_banned(user_id)` - Check if a user ID is banned
- `is_device_banned(device_id)` - Check if a device is banned
- `is_ip_banned(ip_address)` - Check if an IP is banned

### Unbanning a User
To unban a user, use the `unban_user(user_id)` function which:
- Removes the user from `banned_users`
- Removes all associated devices from `banned_devices`
- Removes all associated IPs from `banned_ips`

## API Endpoints

### POST `/api/ban-user`
**Purpose**: Ban a user and all associated devices/IPs

**Request Body**:
```json
{
  "userId": "string (required)",
  "reason": "string (optional)"
}
```

**Success Response** (200):
```json
{
  "success": true,
  "message": "User banned successfully",
  "banned": {
    "userId": "user-id",
    "ips": 2,
    "devices": 1
  }
}
```

**Error Responses**:
- 400: Missing user ID
- 405: Wrong HTTP method
- 500: Database error

## Dashboard Integration

### BanUserButton Component
Located at: `seemedash-v2/components/BanUserButton.tsx`

**Props**:
- `userId` (string): The user ID to ban
- `userName` (string): Display name for confirmation dialog

**Features**:
- Confirmation dialog before banning
- Optional reason input
- Success/error feedback
- Auto-refresh after successful ban

**Usage**:
```tsx
<BanUserButton 
  userId="user-uuid-here" 
  userName="User Display Name" 
/>
```

## Environment Configuration

### Backend (.env)
```env
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### Dashboard (.env.local)
```env
NEXT_PUBLIC_BACKEND_URL=https://seeme-backend.vercel.app/
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

## Security Features

1. **CORS Protection**: API endpoint has CORS headers configured
2. **Row Level Security (RLS)**: All ban tables have RLS enabled
3. **Service Role Access**: Only service role can modify ban tables
4. **Comprehensive Logging**: All ban attempts are logged with console output

## Troubleshooting

### Issue: "JSON parse error" or "CORS error"
**Solution**: Ensure `NEXT_PUBLIC_BACKEND_URL` is set correctly in the dashboard's `.env.local` file

### Issue: "Failed to fetch device data"
**Solution**: Check that the `device_tracking` table exists and has data for the user

### Issue: "Failed to ban user"
**Solution**: 
1. Verify Supabase service role key is correct
2. Check that RLS policies are properly configured
3. Ensure the migration was applied successfully

### Issue: User can still access after ban
**Solution**: 
1. Verify the ban was successful in the database
2. Check that your app's authentication flow checks ban status
3. Ensure device ID and IP tracking is working in your app

## Database Views

### `banned_users_detailed`
Provides a comprehensive view of banned users with:
- User email
- Ban reason and timestamp
- Count of banned devices
- Count of banned IPs
- Access attempts since ban

**Query Example**:
```sql
SELECT * FROM banned_users_detailed 
ORDER BY banned_at DESC;
```

## Next Steps

To fully integrate the ban system into your app:

1. **Add Ban Checks**: Update your authentication flow to check if a user/device/IP is banned before allowing access

2. **Track Devices**: Ensure your iOS app sends device ID and IP address to the backend for tracking

3. **Monitor Bans**: Use the `banned_users_detailed` view in your dashboard to monitor banned users

4. **Handle Ban Attempts**: Log and alert on repeated access attempts from banned users (stored in `banned_access_attempts`)

## Migration File
Location: `supabase/migrations/007_ban_system.sql`

This migration creates all necessary tables, indexes, functions, and views for the ban system.
