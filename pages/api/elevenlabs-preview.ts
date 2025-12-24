import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { elevenLabsKeyManager } from '../../lib/elevenlabs-key-manager'

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

    const { voiceId, text } = req.body

    if (!voiceId || !text) {
      return res.status(400).json({ error: 'voiceId and text are required' })
    }

    // Get an active ElevenLabs API key
    const apiKey = await elevenLabsKeyManager.getAvailableKey()
    if (!apiKey) {
      return res.status(503).json({ error: 'No ElevenLabs API keys available' })
    }

    // Request TTS from ElevenLabs
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        })
      }
    )

    if (!response.ok) {
      throw new Error(`ElevenLabs API error: ${response.statusText}`)
    }

    // Stream audio back to client
    const audioBuffer = await response.arrayBuffer()
    res.setHeader('Content-Type', 'audio/mpeg')
    res.send(Buffer.from(audioBuffer))
  } catch (error: any) {
    console.error('Error generating voice preview:', error)
    res.status(500).json({ error: error.message })
  }
}
