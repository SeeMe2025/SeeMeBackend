import type { NextApiRequest, NextApiResponse } from 'next'
import OpenAI from 'openai'
import { writeFile, unlink } from 'fs/promises'
import { randomUUID } from 'crypto'
import path from 'path'
import { createReadStream } from 'fs'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const DEFAULT_VOICE_LIMIT = 3 // Fallback voice limit per day

// Helper to fetch global voice limit from database
async function getGlobalVoiceLimit(): Promise<number> {
  try {
    const { data } = await supabase
      .from('global_settings')
      .select('value')
      .eq('key', 'default_voice_limit')
      .single()
    return data ? parseInt(data.value) : DEFAULT_VOICE_LIMIT
  } catch {
    return DEFAULT_VOICE_LIMIT
  }
}

async function checkAndIncrementVoiceLimit(
  deviceId: string,
  userId?: string
): Promise<{ allowed: boolean; message?: string; limit?: number; usage?: number; resetAt?: string }> {
  try {
    // Get global voice limit from database
    const globalVoiceLimit = await getGlobalVoiceLimit()

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

    const voiceLimit = customVoiceLimit || globalVoiceLimit

    // Fetch current usage
    const { data: currentUsage, error: fetchError } = await supabase
      .from('usage_limits')
      .select('*')
      .eq('device_id', deviceId)
      .single()

    // If no record exists, create one
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

    // Check if reset is needed
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

    // Users with ElevenLabs key bypass voice limit
    if (currentUsage.has_elevenlabs_key) {
      await supabase
        .from('usage_limits')
        .update({
          voice_sessions_count: currentUsage.voice_sessions_count + 1
        })
        .eq('device_id', deviceId)

      return { allowed: true }
    }

    // Check if limit reached
    if (currentUsage.voice_sessions_count >= voiceLimit) {
      return {
        allowed: false,
        message: `Voice limit of ${voiceLimit} messages per day reached. Resets at midnight.`,
        limit: voiceLimit,
        usage: currentUsage.voice_sessions_count,
        resetAt: currentUsage.reset_at
      }
    }

    // Increment voice count
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
    // On error, allow the request to proceed
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
    const { voiceId, text, withTimestamps, settings, deviceId, userId } = req.body

    console.log('🎤 [OpenAI TTS] Request received:', {
      voiceId,
      textLength: text?.length || 0,
      withTimestamps,
      speed: settings?.speed || 1.0,
      hasDeviceId: !!deviceId,
      hasUserId: !!userId,
      deviceId: deviceId ? deviceId.substring(0, 8) + '...' : 'none',
      userId: userId ? userId.substring(0, 8) + '...' : 'none'
    })

    if (!voiceId || !text) {
      console.error('❌ [OpenAI TTS] Missing required fields:', { voiceId: !!voiceId, text: !!text })
      return res.status(400).json({ error: 'voiceId and text are required' })
    }

    // Rate limiting: apply to all users if deviceId is provided
    if (deviceId) {
      console.log('🔒 [OpenAI TTS] Checking rate limit for device:', deviceId.substring(0, 8) + '...')
      const rateLimitResult = await checkAndIncrementVoiceLimit(deviceId, userId)
      
      if (!rateLimitResult.allowed) {
        console.warn('⚠️ [OpenAI TTS] Rate limit exceeded:', {
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
      console.log('✅ [OpenAI TTS] Rate limit check passed')
    } else {
      console.warn('⚠️ [OpenAI TTS] No deviceId provided - skipping rate limit')
    }

    // Always use environment API key
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      console.error('❌ OPENAI_API_KEY environment variable not set')
      return res.status(500).json({ error: 'OpenAI API key not configured' })
    }
    
    const openai = new OpenAI({ apiKey })

    console.log('🎵 [OpenAI TTS] Generating audio:', { voiceId, speed: settings?.speed || 1.0 })
    const ttsResponse = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: voiceId,
      input: text,
      response_format: "mp3",
      speed: settings?.speed || 1.0
    })

    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer())
    const audio_base64 = audioBuffer.toString('base64')
    console.log('✅ [OpenAI TTS] Audio generated:', { sizeKB: (audioBuffer.length / 1024).toFixed(2) })

    let alignment = null

    if (withTimestamps) {
      console.log('📝 [OpenAI TTS] Generating word timestamps with Whisper...')
      const tempFile = path.join('/tmp', `tts-${randomUUID()}.mp3`)
      await writeFile(tempFile, audioBuffer)

      try {
        const transcription = await openai.audio.transcriptions.create({
          file: createReadStream(tempFile) as any,
          model: "whisper-1",
          response_format: "verbose_json",
          timestamp_granularities: ["word"]
        })

        alignment = {
          words: (transcription as any).words?.map((w: any) => ({
            word: w.word,
            start: w.start,
            end: w.end
          })) || []
        }
        console.log('✅ [OpenAI TTS] Timestamps generated:', { wordCount: alignment.words.length })
      } finally {
        await unlink(tempFile).catch(() => {})
      }
    }

    // Log TTS usage
    try {
      await supabase.from('ai_interactions').insert({
        user_id: userId || 'anonymous',
        provider: 'openai',
        model: 'gpt-4o-mini-tts',
        interaction_type: 'tts',
        status: 'success',
        prompt_type: 'tts',
        message_length: text.length,
        event_type: 'tts_request',
        created_at: new Date().toISOString()
      })
    } catch (logError) {
      console.error('Failed to log TTS usage:', logError)
    }

    console.log('✅ [OpenAI TTS] Request completed successfully')
    res.setHeader('Content-Type', 'application/json')
    res.json({
      audio_base64,
      alignment
    })
  } catch (error: any) {
    console.error('❌ [OpenAI TTS] Error:', {
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join('\n')
    })
    res.status(500).json({ error: error.message })
  }
}
