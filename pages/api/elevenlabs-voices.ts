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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // No authentication - privacy-first app

    // Get an active ElevenLabs API key
    const apiKey = await elevenLabsKeyManager.getAvailableKey()
    if (!apiKey) {
      return res.status(503).json({ error: 'No ElevenLabs API keys available' })
    }

    // Fetch voices from ElevenLabs
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: {
        'xi-api-key': apiKey
      }
    })

    if (!response.ok) {
      throw new Error(`ElevenLabs API error: ${response.statusText}`)
    }

    const data = await response.json()

    res.status(200).json(data)
  } catch (error: any) {
    console.error('Error fetching ElevenLabs voices:', error)
    res.status(500).json({ error: error.message })
  }
}
