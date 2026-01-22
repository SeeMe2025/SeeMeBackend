import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Banned users/devices/IPs - keep in sync with ai-gateway.ts
const BANNED_DEVICES: string[] = [
  'D0758F58-C953-40F7-9533-9DBBC4FB5FCB',
  '2B0779F3-5542-41C7-9663-7ABA3609BF61',
]

const BANNED_USERS: string[] = [
  '3ab1a756-cb96-49b0-b585-0f10efe631c1',
  '4d6dc8e7-21b6-43dd-bd04-38a21124d8d2',
  '3787eb48-5be0-49eb-9c97-58c6201cc074',
]

const BANNED_IPS: string[] = []

const IMAGE_LIMIT_PER_DAY = 5 // Lower limit for expensive DALL-E 3

function getClientIP(req: NextApiRequest): string {
  const forwarded = req.headers['x-forwarded-for']
  const ip = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : req.socket.remoteAddress
  return ip || 'unknown'
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { prompt, size = '1024x1024', quality = 'standard', style = 'natural', deviceId, userId } = req.body

    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' })
    }

    // Require deviceId for rate limiting
    if (!deviceId || deviceId.trim().length === 0) {
      return res.status(400).json({ 
        error: 'Device ID is required',
        details: 'Please update your app to the latest version'
      })
    }

    // Get client IP
    const clientIP = getClientIP(req)

    // Check bans
    if (BANNED_IPS.includes(clientIP)) {
      console.log(`🚫 Banned IP attempted image generation: ${clientIP}`)
      return res.status(403).json({ error: 'Access denied' })
    }

    if (BANNED_DEVICES.includes(deviceId)) {
      console.log(`🚫 Banned device attempted image generation - Device: ${deviceId}, IP: ${clientIP}`)
      return res.status(403).json({ error: 'Access denied' })
    }

    if (userId && BANNED_USERS.includes(userId)) {
      console.log(`🚫 Banned user attempted image generation - User: ${userId}, IP: ${clientIP}`)
      return res.status(403).json({ error: 'Access denied' })
    }

    // Check rate limit for image generation
    const { data: usage } = await supabase
      .from('usage_limits')
      .select('*')
      .eq('device_id', deviceId)
      .single()

    let imageCount = 0
    if (usage) {
      // Check if we need to reset (daily reset at midnight UTC)
      const now = new Date()
      const resetAt = usage.reset_at ? new Date(usage.reset_at) : null
      
      if (!resetAt || now >= resetAt) {
        // Reset image count
        const nextReset = new Date(now)
        nextReset.setUTCDate(nextReset.getUTCDate() + 1)
        nextReset.setUTCHours(0, 0, 0, 0)

        await supabase
          .from('usage_limits')
          .update({ 
            image_generations_count: 0,
            reset_at: nextReset.toISOString()
          })
          .eq('device_id', deviceId)
        
        imageCount = 0
      } else {
        imageCount = usage.image_generations_count || 0
      }
    }

    // Check if limit exceeded
    if (imageCount >= IMAGE_LIMIT_PER_DAY) {
      return res.status(429).json({
        error: 'Image generation limit reached',
        details: `You can generate ${IMAGE_LIMIT_PER_DAY} images per day`,
        used: imageCount,
        max: IMAGE_LIMIT_PER_DAY
      })
    }

    // Increment image count
    if (usage) {
      await supabase
        .from('usage_limits')
        .update({ image_generations_count: imageCount + 1 })
        .eq('device_id', deviceId)
    } else {
      // Create new record
      const nextReset = new Date()
      nextReset.setUTCDate(nextReset.getUTCDate() + 1)
      nextReset.setUTCHours(0, 0, 0, 0)

      await supabase
        .from('usage_limits')
        .insert({
          device_id: deviceId,
          text_sessions_count: 0,
          voice_sessions_count: 0,
          image_generations_count: 1,
          reset_at: nextReset.toISOString()
        })
    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('OpenAI API key not configured')
    }

    const startTime = Date.now()

    // Generate request ID
    const requestId = `img_${Date.now()}_${Math.random().toString(36).substring(7)}`

    // Log image generation request
    await supabase.from('ai_interactions').insert({
      user_id: 'anonymous',
      provider: 'openai',
      model: 'dall-e-3',
      prompt_type: 'image_generation',
      interaction_type: 'image_generation',
      message_length: prompt.length,
      request_id: requestId,
      status: 'pending',
      timestamp: new Date().toISOString()
    })

    // Call OpenAI DALL-E API
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size,
        quality,
        style
      })
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`)
    }

    const data = await response.json()
    const latencyMs = Date.now() - startTime

    // Log image generation response
    await supabase.from('ai_interactions').insert({
      user_id: 'anonymous',
      provider: 'openai',
      model: 'dall-e-3',
      prompt_type: 'image_generation',
      interaction_type: 'image_generation',
      response_time_ms: latencyMs,
      request_id: requestId,
      status: 'success',
      timestamp: new Date().toISOString()
    })

    res.status(200).json({
      imageUrl: data.data[0].url,
      revisedPrompt: data.data[0].revised_prompt,
      requestId
    })
  } catch (error: any) {
    console.error('Error generating image:', error)

    // Log error
    try {
      await supabase.from('ai_interactions').insert({
        user_id: 'anonymous',
        provider: 'openai',
        model: 'dall-e-3',
        prompt_type: 'image_generation',
        interaction_type: 'image_generation',
        error_category: error.name || 'unknown_error',
        error_message: error.message || 'Unknown error occurred',
        event_type: 'error',
        created_at: new Date().toISOString()
      })
    } catch (logError) {
      console.error('Failed to log error:', logError)
    }

    res.status(500).json({ error: error.message })
  }
}
