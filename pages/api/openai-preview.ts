import type { NextApiRequest, NextApiResponse } from 'next'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const DEFAULT_VOICE_LIMIT = 3 // Default voice limit per day

async function checkAndIncrementVoiceLimit(
  deviceId: string,
  userId?: string
): Promise<{ allowed: boolean; message?: string; limit?: number; usage?: number; resetAt?: string }> {
  try {
    // Get custom voice limit from user_limits if userId provided
    let customVoiceLimit: number | null = null
    if (userId) {
      const { data: userLimit } = await supabase
        .from('user_limits')
        .select('custom_voice_limit')
        .eq('user_id', userId)
        .single()
      
      customVoiceLimit = userLimit?.custom_voice_limit || null
    }

    const voiceLimit = customVoiceLimit || DEFAULT_VOICE_LIMIT

    const { data: currentUsage, error: fetchError } = await supabase
      .from('usage_limits')
      .select('*')
      .eq('device_id', deviceId)
      .single()

    if (fetchError || !currentUsage) {
      const resetAt = new Date()
      resetAt.setHours(24, 0, 0, 0)

      const { error: insertError } = await supabase
        .from('usage_limits')
        .insert({
          device_id: deviceId,
          voice_sessions_count: 1,
          text_sessions_count: 0,
          has_elevenlabs_key: false,
          reset_at: resetAt.toISOString()
        })

      if (insertError) throw insertError
      return { allowed: true }
    }

    const now = new Date()
    const resetAt = new Date(currentUsage.reset_at)

    if (now >= resetAt) {
      const newResetAt = new Date()
      newResetAt.setHours(24, 0, 0, 0)

      const { error: resetError } = await supabase
        .from('usage_limits')
        .update({
          voice_sessions_count: 1,
          text_sessions_count: 0,
          reset_at: newResetAt.toISOString()
        })
        .eq('device_id', deviceId)

      if (resetError) throw resetError
      return { allowed: true }
    }

    if (currentUsage.has_elevenlabs_key) {
      await supabase
        .from('usage_limits')
        .update({
          voice_sessions_count: currentUsage.voice_sessions_count + 1
        })
        .eq('device_id', deviceId)

      return { allowed: true }
    }

    if (currentUsage.voice_sessions_count >= voiceLimit) {
      return {
        allowed: false,
        message: `Voice limit of ${voiceLimit} messages per day reached. Resets at midnight.`,
        limit: voiceLimit,
        usage: currentUsage.voice_sessions_count,
        resetAt: currentUsage.reset_at
      }
    }

    const { error: updateError } = await supabase
      .from('usage_limits')
      .update({
        voice_sessions_count: currentUsage.voice_sessions_count + 1
      })
      .eq('device_id', deviceId)

    if (updateError) throw updateError

    return { allowed: true }
  } catch (error) {
    console.error('Error checking voice rate limit:', error)
    return { allowed: true }
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { voiceId, text, deviceId, userId } = req.body

    console.log('🔊 [OpenAI Preview] Request received:', {
      voiceId,
      textLength: text?.length || 0,
      hasDeviceId: !!deviceId,
      hasUserId: !!userId,
      deviceId: deviceId ? deviceId.substring(0, 8) + '...' : 'none',
      userId: userId ? userId.substring(0, 8) + '...' : 'none'
    })

    if (!voiceId || !text) {
      console.error('❌ [OpenAI Preview] Missing required fields:', { voiceId: !!voiceId, text: !!text })
      return res.status(400).json({ error: 'voiceId and text are required' })
    }

    // Rate limiting: apply to all users if deviceId is provided
    if (deviceId) {
      console.log('🔒 [OpenAI Preview] Checking rate limit for device:', deviceId.substring(0, 8) + '...')
      const rateLimitResult = await checkAndIncrementVoiceLimit(deviceId, userId)
      
      if (!rateLimitResult.allowed) {
        console.warn('⚠️ [OpenAI Preview] Rate limit exceeded:', {
          deviceId: deviceId.substring(0, 8) + '...',
          limit: rateLimitResult.limit,
          usage: rateLimitResult.usage,
          resetAt: rateLimitResult.resetAt
        })
        return res.status(429).json({ 
          error: 'Voice limit reached',
          message: rateLimitResult.message,
          limit: rateLimitResult.limit,
          usage: rateLimitResult.usage,
          resetAt: rateLimitResult.resetAt
        })
      }
      console.log('✅ [OpenAI Preview] Rate limit check passed')
    } else {
      console.warn('⚠️ [OpenAI Preview] No deviceId provided - skipping rate limit')
    }

    // Always use environment API key
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      console.error('❌ OPENAI_API_KEY environment variable not set')
      return res.status(500).json({ error: 'OpenAI API key not configured' })
    }
    
    const openai = new OpenAI({ apiKey })

    console.log('🎵 [OpenAI Preview] Generating preview audio:', { voiceId })
    const response = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: voiceId,
      input: text,
      response_format: "mp3"
    })

    const audioBuffer = Buffer.from(await response.arrayBuffer())
    console.log('✅ [OpenAI Preview] Audio generated:', { sizeKB: (audioBuffer.length / 1024).toFixed(2) })

    console.log('✅ [OpenAI Preview] Request completed successfully')
    res.setHeader('Content-Type', 'audio/mpeg')
    res.send(audioBuffer)
  } catch (error: any) {
    console.error('❌ [OpenAI Preview] Error:', {
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join('\n')
    })
    res.status(500).json({ error: error.message })
  }
}
