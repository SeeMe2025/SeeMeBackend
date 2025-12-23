import type { NextApiRequest, NextApiResponse } from 'next'
import { elevenLabsKeyManager } from '../../lib/elevenlabs-key-manager'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const statuses = await elevenLabsKeyManager.getAllKeyStatuses()

    const summary = {
      totalKeys: statuses.length,
      activeKeys: statuses.filter(s => s.status === 'active' && !s.isOverLimit).length,
      exhaustedKeys: statuses.filter(s => s.isOverLimit).length,
      nearLimitKeys: statuses.filter(s => s.isNearLimit && !s.isOverLimit).length,
      totalRemainingCharacters: statuses.reduce((sum, s) => sum + s.remainingCharacters, 0),
      keys: statuses.map(s => ({
        shortKey: s.shortKey,
        status: s.status,
        characterCount: s.characterCount,
        characterLimit: s.characterLimit,
        remainingCharacters: s.remainingCharacters,
        usagePercentage: Math.round(s.usagePercentage * 100),
        isOverLimit: s.isOverLimit,
        isNearLimit: s.isNearLimit,
        nextResetDate: s.nextResetDate
      }))
    }

    res.status(200).json(summary)
  } catch (error: any) {
    console.error('Error fetching ElevenLabs status:', error)
    res.status(500).json({ error: error.message })
  }
}
