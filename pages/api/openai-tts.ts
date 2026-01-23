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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { voiceId, text, withTimestamps, settings, userApiKey } = req.body

    if (!voiceId || !text) {
      return res.status(400).json({ error: 'voiceId and text are required' })
    }

    const apiKey = userApiKey || process.env.OPENAI_API_KEY
    if (!apiKey) {
      console.error('❌ OPENAI_API_KEY environment variable not set and no userApiKey provided')
      return res.status(500).json({ error: 'OpenAI API key not configured' })
    }
    
    // Log which key source is being used
    if (userApiKey) {
      console.log('🔑 Using user-provided API key:', userApiKey.substring(0, 10) + '...')
    } else {
      console.log('🔑 Using environment API key:', process.env.OPENAI_API_KEY?.substring(0, 10) + '...')
    }
    
    // Validate API key format
    if (!apiKey.startsWith('sk-')) {
      console.error('❌ Invalid API key format. Expected "sk-" but got:', apiKey.substring(0, 10) + '...')
      return res.status(400).json({ error: 'Invalid API key format. API keys must start with "sk-"' })
    }
    
    const openai = new OpenAI({ apiKey })

    const ttsResponse = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: voiceId,
      input: text,
      response_format: "mp3",
      speed: settings?.speed || 1.0
    })

    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer())
    const audio_base64 = audioBuffer.toString('base64')

    let alignment = null

    if (withTimestamps) {
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
      } finally {
        await unlink(tempFile).catch(() => {})
      }
    }

    try {
      await supabase.from('ai_interactions').insert({
        user_id: 'anonymous',
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

    res.setHeader('Content-Type', 'application/json')
    res.json({
      audio_base64,
      alignment
    })
  } catch (error: any) {
    console.error('Error generating OpenAI TTS:', error)
    res.status(500).json({ error: error.message })
  }
}
