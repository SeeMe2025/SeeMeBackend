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
    const { prompt, aspectRatio = '9:16' } = req.body

    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' })
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      throw new Error('Gemini API key not configured')
    }

    const startTime = Date.now()

    const requestId = `vb_${Date.now()}_${Math.random().toString(36).substring(7)}`

    await supabase.from('ai_usage').insert({
      user_id: 'anonymous',
      provider: 'gemini',
      model: 'imagen-4.0-generate-001',
      prompt_type: 'vision_board_generation',
      message_length: prompt.length,
      request_id: requestId,
      event_type: 'request',
      created_at: new Date().toISOString()
    })

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          instances: [
            {
              prompt: prompt
            }
          ],
          parameters: {
            sampleCount: 1,
            aspectRatio: aspectRatio
          }
        })
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Gemini API error response:', errorText)
      let errorMessage = response.statusText
      try {
        const error = JSON.parse(errorText)
        errorMessage = error.error?.message || errorMessage
      } catch (e) {
        // If JSON parsing fails, use the text as is
      }
      throw new Error(`Gemini API error: ${errorMessage}`)
    }

    const responseText = await response.text()
    let data
    try {
      data = JSON.parse(responseText)
    } catch (e) {
      console.error('Failed to parse response:', responseText)
      throw new Error('Invalid JSON response from Gemini API')
    }

    const latencyMs = Date.now() - startTime

    await supabase.from('ai_usage').insert({
      user_id: 'anonymous',
      provider: 'gemini',
      model: 'imagen-4.0-generate-001',
      prompt_type: 'vision_board_generation',
      latency_ms: latencyMs,
      request_id: requestId,
      event_type: 'response',
      created_at: new Date().toISOString()
    })

    // Imagen :predict API returns predictions array with bytesBase64Encoded
    const imageBase64 = data.predictions?.[0]?.bytesBase64Encoded

    if (!imageBase64) {
      console.error('Unexpected response structure:', JSON.stringify(data))
      throw new Error('No image generated')
    }

    res.status(200).json({
      imageBase64: `data:image/png;base64,${imageBase64}`,
      requestId
    })
  } catch (error: any) {
    console.error('Error generating vision board image:', error)

    try {
      await supabase.from('ai_usage').insert({
        user_id: 'anonymous',
        provider: 'gemini',
        prompt_type: 'vision_board_generation',
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
