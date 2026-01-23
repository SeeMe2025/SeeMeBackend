# User ID Standardization Issue

## Problem

The iOS app is sending user ID: `CF8C1C64-7661-431A-A111-06D2127D9696`
But the database has user: `0341e1bd-f4cd-4a16-be8f-04bfb3ce7882` (Yanksss)

**These are different users!** The iOS app has a local user that doesn't exist in Supabase.

## Root Cause

The iOS app uses SwiftData for local storage, which creates its own user IDs. These local user IDs are NOT synced with Supabase's `users` table.

## Current State

Your tables have MIXED user_id types:
- `users` table: UUID type ✅
- `ai_usage_tracking`: UUID type ✅  
- `user_logs`: TEXT type ❌
- `errors`: TEXT type ❌
- `ai_interactions`: TEXT type ❌
- `banned_users`: TEXT type ❌

## Solution

### Option 1: Sync iOS User to Supabase (RECOMMENDED)

When a user is created in the iOS app, also create them in Supabase `users` table:

```swift
// In iOS app after user creation
func syncUserToSupabase(user: User) async {
    let supabase = SupabaseClient(...)
    
    try await supabase
        .from("users")
        .insert([
            "id": user.id.uuidString,
            "name": user.name,
            "age": user.age,
            "created_at": user.createdAt
        ])
        .execute()
}
```

### Option 2: Standardize All Tables to UUID

Run this SQL to convert all TEXT user_id columns to UUID:

```sql
-- Convert user_logs
ALTER TABLE user_logs ALTER COLUMN user_id TYPE UUID USING user_id::UUID;
ALTER TABLE user_logs ADD CONSTRAINT fk_user_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- Convert errors
ALTER TABLE errors ALTER COLUMN user_id TYPE UUID USING user_id::UUID;
ALTER TABLE errors ADD CONSTRAINT fk_errors_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- Convert ai_interactions
ALTER TABLE ai_interactions ALTER COLUMN user_id TYPE UUID USING user_id::UUID;
ALTER TABLE ai_interactions ADD CONSTRAINT fk_ai_interactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- Convert banned_users
ALTER TABLE banned_users ALTER COLUMN user_id TYPE UUID USING user_id::UUID;
ALTER TABLE banned_users ADD CONSTRAINT fk_banned_users_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
```

## Immediate Fix for Limit Increase Request

The current error happens because user `CF8C1C64-7661-431A-A111-06D2127D9696` doesn't exist in `users` table.

**Quick fix:** The API already handles this by using defaults when user not found. Just need to verify the RLS policy was applied correctly.

Run this in Supabase SQL Editor:

```sql
-- Check if policy exists
SELECT * FROM pg_policies WHERE tablename = 'users';

-- If not, create it
CREATE POLICY "Allow reading user info for limit requests"
ON users FOR SELECT USING (true);
```

## Long-term Solution

1. ✅ Ensure all tables use UUID for user_id
2. ✅ Add foreign key constraints to `users` table
3. ✅ Sync iOS users to Supabase on creation
4. ✅ Update all functions to use UUID type

This ensures ONE source of truth: the `users` table.
