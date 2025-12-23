import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface ElevenLabsSubscription {
  tier: string
  character_count: number
  character_limit: number
  voice_slots_used: number
  voice_limit: number
  status: string
  next_character_count_reset_unix: number
}

interface KeyStatus {
  key: string
  shortKey: string
  characterCount: number
  characterLimit: number
  remainingCharacters: number
  usagePercentage: number
  isOverLimit: boolean
  isNearLimit: boolean
  nextResetDate: Date
  lastChecked: Date
  status: 'active' | 'exhausted' | 'rate_limited' | 'invalid'
}

class ElevenLabsKeyManager {
  private keys: string[]
  private currentKeyIndex: number = 0
  private keyStatuses: Map<string, KeyStatus> = new Map()
  private lastRotation: Date = new Date()

  constructor() {
    const keysEnv = process.env.ELEVENLABS_API_KEYS || ''
    this.keys = keysEnv.split(',').map(k => k.trim()).filter(k => k.length > 0)

    if (this.keys.length === 0) {
      console.warn('⚠️ No ElevenLabs API keys configured!')
    } else {
      console.log(`✅ Loaded ${this.keys.length} ElevenLabs API keys`)
    }
  }

  getCurrentKey(): string {
    if (this.keys.length === 0) {
      throw new Error('No ElevenLabs API keys available')
    }
    return this.keys[this.currentKeyIndex]
  }

  async getAvailableKey(): Promise<string> {
    if (this.keys.length === 0) {
      throw new Error('No ElevenLabs API keys configured')
    }

    const startIndex = this.currentKeyIndex
    let attempts = 0

    while (attempts < this.keys.length) {
      const candidateKey = this.keys[this.currentKeyIndex]
      const status = this.keyStatuses.get(candidateKey)

      if (!status) {
        await this.checkKeyStatus(candidateKey)
        const newStatus = this.keyStatuses.get(candidateKey)

        if (newStatus && newStatus.status === 'active' && !newStatus.isOverLimit) {
          console.log(`✅ Using key ${newStatus.shortKey} (${newStatus.remainingCharacters.toLocaleString()} chars remaining)`)
          return candidateKey
        }
      } else if (status.status === 'active' && !status.isOverLimit) {
        if (Date.now() - status.lastChecked.getTime() > 60000) {
          await this.checkKeyStatus(candidateKey)
        }

        const updatedStatus = this.keyStatuses.get(candidateKey)
        if (updatedStatus && !updatedStatus.isOverLimit) {
          console.log(`✅ Using key ${updatedStatus.shortKey} (${updatedStatus.remainingCharacters.toLocaleString()} chars remaining)`)
          return candidateKey
        }
      }

      this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length
      attempts++

      if (this.currentKeyIndex === startIndex && attempts >= this.keys.length) {
        break
      }
    }

    throw new Error('All ElevenLabs API keys are exhausted or rate limited')
  }

  async checkKeyStatus(key: string): Promise<KeyStatus> {
    try {
      const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
        headers: {
          'xi-api-key': key,
          'Accept': 'application/json'
        }
      })

      if (response.status === 401) {
        const status: KeyStatus = {
          key,
          shortKey: this.shortenKey(key),
          characterCount: 0,
          characterLimit: 0,
          remainingCharacters: 0,
          usagePercentage: 0,
          isOverLimit: true,
          isNearLimit: false,
          nextResetDate: new Date(),
          lastChecked: new Date(),
          status: 'invalid'
        }
        this.keyStatuses.set(key, status)
        console.error(`❌ Invalid API key: ${status.shortKey}`)
        return status
      }

      if (response.status === 429) {
        const existingStatus = this.keyStatuses.get(key)
        const status: KeyStatus = existingStatus || {
          key,
          shortKey: this.shortenKey(key),
          characterCount: 0,
          characterLimit: 0,
          remainingCharacters: 0,
          usagePercentage: 1.0,
          isOverLimit: true,
          isNearLimit: true,
          nextResetDate: new Date(Date.now() + 60000),
          lastChecked: new Date(),
          status: 'rate_limited'
        }
        this.keyStatuses.set(key, status)
        console.warn(`⏳ Rate limited: ${status.shortKey}`)
        return status
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const subscription: ElevenLabsSubscription = await response.json()

      const usagePercentage = subscription.character_limit > 0
        ? subscription.character_count / subscription.character_limit
        : 0

      const remainingCharacters = Math.max(0, subscription.character_limit - subscription.character_count)
      const isOverLimit = subscription.character_count >= subscription.character_limit
      const isNearLimit = usagePercentage >= 0.8

      const status: KeyStatus = {
        key,
        shortKey: this.shortenKey(key),
        characterCount: subscription.character_count,
        characterLimit: subscription.character_limit,
        remainingCharacters,
        usagePercentage,
        isOverLimit,
        isNearLimit,
        nextResetDate: new Date(subscription.next_character_count_reset_unix * 1000),
        lastChecked: new Date(),
        status: isOverLimit ? 'exhausted' : 'active'
      }

      this.keyStatuses.set(key, status)

      await this.trackKeyUsage(key, status)

      if (isNearLimit) {
        console.warn(`⚠️ Key ${status.shortKey} near limit: ${remainingCharacters.toLocaleString()} chars remaining (${(usagePercentage * 100).toFixed(1)}%)`)
      }

      return status
    } catch (error) {
      console.error(`❌ Error checking key status: ${error}`)
      throw error
    }
  }

  async handleAPIError(statusCode: number, key: string): Promise<void> {
    const shortKey = this.shortenKey(key)

    switch (statusCode) {
      case 429:
        console.warn(`⏳ Rate limit hit for key ${shortKey} - rotating to next key`)
        await this.rotateKey()
        break

      case 401:
        console.error(`❌ Invalid API key: ${shortKey}`)
        const invalidStatus: KeyStatus = {
          key,
          shortKey,
          characterCount: 0,
          characterLimit: 0,
          remainingCharacters: 0,
          usagePercentage: 0,
          isOverLimit: true,
          isNearLimit: false,
          nextResetDate: new Date(),
          lastChecked: new Date(),
          status: 'invalid'
        }
        this.keyStatuses.set(key, invalidStatus)
        await this.rotateKey()
        break

      case 402:
      case 403:
        console.warn(`💳 Quota exceeded for key ${shortKey} - rotating to next key`)
        await this.checkKeyStatus(key)
        await this.rotateKey()
        break

      default:
        console.error(`❌ API error ${statusCode} for key ${shortKey}`)
    }
  }

  async rotateKey(): Promise<void> {
    this.lastRotation = new Date()
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length
    console.log(`🔄 Rotated to key index ${this.currentKeyIndex}`)
  }

  async getAllKeyStatuses(): Promise<KeyStatus[]> {
    const statuses: KeyStatus[] = []

    for (const key of this.keys) {
      try {
        const status = await this.checkKeyStatus(key)
        statuses.push(status)
      } catch (error) {
        console.error(`Error checking key status: ${error}`)
      }
    }

    return statuses
  }

  getKeyStatusSummary(): string {
    let summary = `\n📊 ElevenLabs Key Status Summary (${this.keys.length} keys)\n`
    summary += `${'='.repeat(60)}\n`

    this.keyStatuses.forEach((status, key) => {
      const isActive = this.keys[this.currentKeyIndex] === key
      const activeMarker = isActive ? '👉 ' : '   '
      const statusEmoji = {
        'active': status.isNearLimit ? '⚠️' : '✅',
        'exhausted': '🚫',
        'rate_limited': '⏳',
        'invalid': '❌'
      }[status.status]

      summary += `${activeMarker}${statusEmoji} ${status.shortKey}\n`
      summary += `   Status: ${status.status.toUpperCase()}\n`
      summary += `   Usage: ${status.characterCount.toLocaleString()} / ${status.characterLimit.toLocaleString()} chars (${(status.usagePercentage * 100).toFixed(1)}%)\n`
      summary += `   Remaining: ${status.remainingCharacters.toLocaleString()} chars\n`

      if (status.status !== 'invalid') {
        const resetTime = status.nextResetDate.toLocaleString()
        summary += `   Resets: ${resetTime}\n`
      }

      summary += `\n`
    })

    return summary
  }

  private shortenKey(key: string): string {
    if (key.length <= 20) return key
    return `${key.substring(0, 12)}...${key.substring(key.length - 8)}`
  }

  private async trackKeyUsage(key: string, status: KeyStatus): Promise<void> {
    try {
      const { error } = await supabase
        .from('elevenlabs_key_usage')
        .upsert({
          api_key_hash: this.hashKey(key),
          short_key: status.shortKey,
          character_count: status.characterCount,
          character_limit: status.characterLimit,
          remaining_characters: status.remainingCharacters,
          usage_percentage: status.usagePercentage,
          is_over_limit: status.isOverLimit,
          is_near_limit: status.isNearLimit,
          next_reset_date: status.nextResetDate.toISOString(),
          status: status.status,
          last_checked: new Date().toISOString()
        }, {
          onConflict: 'api_key_hash'
        })

      if (error) {
        console.error('Error tracking key usage:', error)
      }
    } catch (error) {
      console.error('Error saving key usage to Supabase:', error)
    }
  }

  private hashKey(key: string): string {
    let hash = 0
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return hash.toString(36)
  }
}

export const elevenLabsKeyManager = new ElevenLabsKeyManager()
