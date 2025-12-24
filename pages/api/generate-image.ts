import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // No authentication - privacy-first app

    const { prompt, size = '1024x1024', quality = 'standard', style = 'natural' } = req.body

    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' })
    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('OpenAI API key not configured')
    }

    const startTime = Date.now()

    // Generate request ID
    const requestId = `img_${Date.now()}_${Math.random().toString(36).substring(7)}`

    // Log image generation request
    await supabase.from('ai_usage').insert({
      user_id: 'anonymous',
      provider: 'openai',
      model: 'dall-e-3',
      prompt_type: 'image_generation',
      message_length: prompt.length,
      request_id: requestId,
      event_type: 'request',
      created_at: new Date().toISOString()
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
    await supabase.from('ai_usage').insert({
      user_id: 'anonymous',
      provider: 'openai',
      model: 'dall-e-3',
      prompt_type: 'image_generation',
      latency_ms: latencyMs,
      request_id: requestId,
      event_type: 'response',
      created_at: new Date().toISOString()
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
      await supabase.from('ai_usage').insert({
        user_id: 'anonymous',
        provider: 'openai',
        prompt_type: 'image_generation',
        error_type: error.name || 'unknown_error',
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
