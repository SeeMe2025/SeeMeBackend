import type { NextApiRequest, NextApiResponse } from 'next'
import OpenAI from 'openai'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { voiceId, text } = req.body

    if (!voiceId || !text) {
      return res.status(400).json({ error: 'voiceId and text are required' })
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const response = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: voiceId,
      input: text,
      response_format: "mp3"
    })

    const audioBuffer = Buffer.from(await response.arrayBuffer())

    res.setHeader('Content-Type', 'audio/mpeg')
    res.send(audioBuffer)
  } catch (error: any) {
    console.error('Error generating OpenAI voice preview:', error)
    res.status(500).json({ error: error.message })
  }
}
