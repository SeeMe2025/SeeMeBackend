import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'

// Vercel function timeout configuration with Fluid Compute (enabled by default)
// Hobby: 300s default/max, Pro: 300s default/800s max, Enterprise: 300s default/800s max
export const config = {
  maxDuration: 300, // seconds - 5 minutes for all plans with Fluid Compute
  api: {
    bodyParser: {
      sizeLimit: '10mb', // Explicit body size limit for large context
    },
  },
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface Tool {
  name?: string
  description?: string
  parameters?: any
  // OpenAI format has tools wrapped in a function object
  function?: {
    name: string
    description: string
    parameters: any
  }
}

interface AIGatewayRequest {
  message: string
  previousMessages: Message[]
  promptType: string
  provider?: 'openai' | 'anthropic'
  model?: string
  tools?: Tool[]
  userApiKey?: string // User's own OpenAI/Anthropic API key
  context?: {
    userId?: string
    sessionId?: string
    coachId?: string
    featureName?: string
    deviceId?: string
    isVoiceMode?: boolean | string
    hasTTS?: boolean | string
    hasElevenLabsKey?: boolean | string
  }
}

// Rate limiting constants
const VOICE_LIMIT = 3
const TEXT_LIMIT = 20

// Banned users/devices list - add deviceIds or userIds here to ban
const BANNED_DEVICES: string[] = [
  'D0758F58-C953-40F7-9533-9DBBC4FB5FCB', // Device used by repeat abuser (Nigger/Gay Jew Boy Nigga)
]

const BANNED_USERS: string[] = [
  '3ab1a756-cb96-49b0-b585-0f10efe631c1', // User: Nigga - abusing API (deleted account)
  '4d6dc8e7-21b6-43dd-bd04-38a21124d8d2', // User: Gay Jew Boy Nigga - same abuser, new account
]

// Banned IPs - add IP addresses here to ban
const BANNED_IPS: string[] = [
  // IPs will be added when we detect repeat offenders
]

// Rate limiting helper functions
// Helper to get client IP from request
function getClientIP(req: NextApiRequest): string {
  const forwarded = req.headers['x-forwarded-for']
  const ip = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : req.socket.remoteAddress
  return ip || 'unknown'
}

async function checkAndIncrementRateLimit(
  deviceId: string,
  isVoiceMode: boolean,
  hasElevenLabsKey: boolean,
  promptType?: string,
  userId?: string,
  clientIP?: string
): Promise<{ allowed: boolean; limitType?: 'voice' | 'text'; used?: number; max?: number; banned?: boolean }> {
  // Check if IP is banned
  if (clientIP && BANNED_IPS.includes(clientIP)) {
    console.log(`🚫 Banned IP attempted access: ${clientIP}`)
    return { allowed: false, limitType: 'text', used: 0, max: 0, banned: true }
  }

  // Check if device is banned
  if (BANNED_DEVICES.includes(deviceId)) {
    console.log(`🚫 Banned device attempted access: ${deviceId}`)
    return { allowed: false, limitType: 'text', used: 0, max: 0, banned: true }
  }
  
  // Check if user is banned
  if (userId && BANNED_USERS.includes(userId)) {
    console.log(`🚫 Banned user attempted access: ${userId}`)
    return { allowed: false, limitType: 'text', used: 0, max: 0, banned: true }
  }

  // Exempt automatic daily refresh tasks from rate limits
  const exemptPromptTypes = ['dailyMetrics', 'dailyBoosts']
  if (promptType && exemptPromptTypes.includes(promptType)) {
    return { allowed: true }
  }
  try {
    // Get or create usage record
    const { data: usage, error: fetchError } = await supabase
      .from('usage_limits')
      .select('*')
      .eq('device_id', deviceId)
      .single()

    let currentUsage = usage

    // Create record if doesn't exist
    if (!currentUsage || fetchError) {
      const now = new Date()
      const resetAt = new Date(now)
      resetAt.setUTCHours(24, 0, 0, 0) // Next midnight UTC

      const { data: newUsage, error: insertError } = await supabase
        .from('usage_limits')
        .insert({
          device_id: deviceId,
          voice_sessions_count: 0,
          text_sessions_count: 0,
          has_elevenlabs_key: hasElevenLabsKey,
          reset_at: resetAt.toISOString()
        })
        .select()
        .single()

      if (insertError) {
        console.error('Failed to create usage record:', insertError)
        return { allowed: true } // Fail open on DB errors
      }
      currentUsage = newUsage
    }

    // Check if we need to reset counts (daily reset at midnight UTC)
    const now = new Date()
    const resetAt = currentUsage.reset_at ? new Date(currentUsage.reset_at) : null
    
    if (!resetAt || now >= resetAt) {
      // Reset counts and set next reset time to next midnight UTC
      const nextReset = new Date(now)
      nextReset.setUTCDate(nextReset.getUTCDate() + 1)
      nextReset.setUTCHours(0, 0, 0, 0) // Next midnight UTC

      const { data: resetUsage, error: resetError } = await supabase
        .from('usage_limits')
        .update({
          voice_sessions_count: 0,
          text_sessions_count: 0,
          reset_at: nextReset.toISOString()
        })
        .eq('device_id', deviceId)
        .select()
        .single()

      if (resetError) {
        console.error('Failed to reset usage counts:', resetError)
        // Continue with existing counts if reset fails
      } else {
        currentUsage = resetUsage
        console.log(`Reset usage counts for device ${deviceId}, next reset: ${nextReset.toISOString()}`)
      }
    }

    // Check voice mode rate limit
    if (isVoiceMode) {
      // Users with ElevenLabs key bypass voice limit
      if (hasElevenLabsKey) {
        return { allowed: true }
      }

      if (currentUsage.voice_sessions_count >= VOICE_LIMIT) {
        return {
          allowed: false,
          limitType: 'voice',
          used: currentUsage.voice_sessions_count,
          max: VOICE_LIMIT
        }
      }

      // Increment voice count
      await supabase
        .from('usage_limits')
        .update({
          voice_sessions_count: currentUsage.voice_sessions_count + 1,
          has_elevenlabs_key: hasElevenLabsKey
        })
        .eq('device_id', deviceId)

      return { allowed: true }
    } else {
      // Check text mode rate limit (no bypass)
      if (currentUsage.text_sessions_count >= TEXT_LIMIT) {
        return {
          allowed: false,
          limitType: 'text',
          used: currentUsage.text_sessions_count,
          max: TEXT_LIMIT
        }
      }

      // Increment text count
      await supabase
        .from('usage_limits')
        .update({ text_sessions_count: currentUsage.text_sessions_count + 1 })
        .eq('device_id', deviceId)

      return { allowed: true }
    }
  } catch (error) {
    console.error('Rate limit check error:', error)
    // Fail closed on errors to prevent abuse
    return { 
      allowed: false, 
      limitType: 'text',
      used: 0,
      max: TEXT_LIMIT
    }
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
    // No authentication - privacy-first app with local-only users
    // Backend is just a secure proxy to hide API keys

    // Parse request body
    const body: AIGatewayRequest = req.body
    const {
      message,
      previousMessages = [],
      promptType,
      provider = 'openai',
      model,
      tools = [],
      context = {}
    } = body

    // Allow empty message for summary requests (all context is in previousMessages)
    if (message === undefined || message === null) {
      return res.status(400).json({ error: 'Message is required' })
    }

    // Check rate limits (skip if user provided their own API key)
    const userProvidedKey = body.userApiKey && body.userApiKey.trim().length > 0

    if (!userProvidedKey) {
      // Require deviceId for rate limiting - reject if missing
      const deviceId = context.deviceId
      if (!deviceId || deviceId.trim().length === 0) {
        return res.status(400).json({ 
          error: 'Device ID is required for rate limiting',
          details: 'Please update your app to the latest version'
        })
      }

      // Parse boolean values (iOS sends as strings)
      const isVoiceMode = context.isVoiceMode === true || context.isVoiceMode === 'true' || context.hasTTS === true || context.hasTTS === 'true'
      const hasElevenLabsKey = context.hasElevenLabsKey === true || context.hasElevenLabsKey === 'true'

      // Get client IP for IP-based banning
      const clientIP = getClientIP(req)

      const rateLimitResult = await checkAndIncrementRateLimit(
        deviceId,
        isVoiceMode,
        hasElevenLabsKey,
        promptType,
        context.userId,
        clientIP
      )

      if (!rateLimitResult.allowed) {
        // Check if user is banned
        if (rateLimitResult.banned) {
          return res.status(403).json({
            error: 'Access denied',
            details: 'Your account has been suspended for violating our terms of service'
          })
        }
        
        return res.status(429).json({
          error: rateLimitResult.limitType === 'voice'
            ? 'Voice session limit reached'
            : 'Text session limit reached',
          limitType: rateLimitResult.limitType,
          used: rateLimitResult.used,
          max: rateLimitResult.max
        })
      }
    }

    // Generate request ID
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`
    const startTime = Date.now()

    // Log AI request to Supabase (userId from context if provided, otherwise anonymous)
    await trackAIRequest({
      userId: context.userId || 'anonymous',
      provider,
      model: model || getDefaultModel(provider),
      promptType,
      messageLength: message.length,
      requestId,
      context
    })

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable buffering in nginx
    })

    // Connection health check - detect client disconnects
    let isClientConnected = true
    req.on('close', () => {
      isClientConnected = false
      console.log('Client disconnected, stopping stream')
    })

    // Stream response with array for better memory efficiency
    const responseChunks: string[] = []
    let tokensUsed: number | undefined
    let streamAborted = false

    if (provider === 'openai') {
      const result = await streamOpenAI(
        message,
        previousMessages,
        model,
        tools,
        (chunk) => {
          if (!isClientConnected) {
            streamAborted = true
            return false // Signal to stop streaming
          }
          responseChunks.push(chunk)
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`, 'utf8')
          return true
        },
        (toolInvocation) => {
          if (isClientConnected) {
            res.write(`data: ${JSON.stringify({ toolInvocation })}\n\n`, 'utf8')
          }
        },
        body.userApiKey // Use user's key if provided
      )
      tokensUsed = result.tokensUsed
    } else if (provider === 'anthropic') {
      const result = await streamAnthropic(
        message,
        previousMessages,
        model,
        tools,
        (chunk) => {
          if (!isClientConnected) {
            streamAborted = true
            return false // Signal to stop streaming
          }
          responseChunks.push(chunk)
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`, 'utf8')
          return true
        },
        (toolInvocation) => {
          if (isClientConnected) {
            res.write(`data: ${JSON.stringify({ toolInvocation })}\n\n`, 'utf8')
          }
        },
        body.userApiKey // Use user's key if provided
      )
      tokensUsed = result.tokensUsed
    }

    // Send completion event if client still connected
    if (isClientConnected && !streamAborted) {
      res.write(`data: [DONE]\n\n`, 'utf8')
    }

    const latencyMs = Date.now() - startTime
    const fullResponse = responseChunks.join('') // Efficient join at the end

    // Log AI response to Supabase (even if client disconnected, for analytics)
    await trackAIResponse({
      userId: context.userId || 'anonymous',
      provider,
      model: model || getDefaultModel(provider),
      promptType,
      responseLength: fullResponse.length,
      tokensUsed,
      latencyMs,
      fromCache: false,
      requestId,
      context,
      streamAborted,
      messageLength: message.length,
      previousMessagesCount: previousMessages.length
    })

    res.end()

  } catch (error: any) {
    console.error('AI Gateway Streaming Error:', error)

    // Create detailed error response for Swift app
    const errorResponse = {
      error: error.message || 'Unknown error occurred',
      errorType: error.name || 'UnknownError',
      errorCode: error.code || 'UNKNOWN',
      provider: req.body.provider || 'unknown',
      model: req.body.model || 'unknown',
      promptType: req.body.promptType || 'unknown',
      requestId: `req_${Date.now()}_error`,
      timestamp: new Date().toISOString(),
      // Additional context for debugging
      context: {
        messageLength: req.body.message?.length || 0,
        previousMessagesCount: req.body.previousMessages?.length || 0,
        hasTools: (req.body.tools?.length || 0) > 0,
        userId: req.body.context?.userId || 'anonymous',
        sessionId: req.body.context?.sessionId,
        coachId: req.body.context?.coachId,
        isVoiceMode: req.body.context?.isVoiceMode || req.body.context?.hasTTS || false
      }
    }

    // Send structured error event to Swift app
    res.write(`data: ${JSON.stringify(errorResponse)}\n\n`)
    res.end()

    // Log detailed error to Supabase
    try {
      await trackAIError({
        userId: req.body.context?.userId || 'anonymous',
        provider: req.body.provider || 'unknown',
        model: req.body.model || getDefaultModel(req.body.provider || 'openai'),
        promptType: req.body.promptType || 'unknown',
        errorType: error.name || 'UnknownError',
        errorMessage: error.message || 'Unknown error occurred',
        errorCode: error.code || 'UNKNOWN',
        requestId: errorResponse.requestId,
        context: req.body.context,
        stackTrace: error.stack?.substring(0, 500) // First 500 chars of stack
      })
    } catch (logError) {
      console.error('Failed to log error to Supabase:', logError)
    }
  }
}

// Helper function to stream from OpenAI
async function streamOpenAI(
  message: string,
  previousMessages: Message[],
  model?: string,
  tools?: Tool[],
  onChunk?: (chunk: string) => boolean | void, // Returns false to abort
  onToolInvocation?: (invocation: any) => void,
  userApiKey?: string
): Promise<{ tokensUsed?: number }> {
  const apiKey = userApiKey || process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OpenAI API key not configured')
  }

  // For regeneration requests (affirmation, focuses, capacity), the message is empty
  // and the actual prompt is in previousMessages. Don't add empty user message.
  const messages = message.trim().length > 0
    ? [
        ...previousMessages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: message }
      ]
    : previousMessages.map(m => ({ role: m.role, content: m.content }))

  const requestBody: any = {
    model: model || 'gpt-5.1',
    messages,
    stream: true
  }

  // Add GPT-5 specific parameters (same as old OpenAIService)
  const modelName = model || 'gpt-5.1'
  if (modelName.startsWith('gpt-5')) {
    const maxTokens = modelName.includes('nano') ? 4096 : 8192
    requestBody.max_completion_tokens = maxTokens
    requestBody.reasoning_effort = 'low'
    requestBody.stream_options = { include_usage: true }
  }

  if (tools && tools.length > 0) {
    // Tools are already in correct OpenAI format from iOS (with type: "function" wrapper)
    requestBody.tools = tools
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`)
  }

  if (!response.body) {
    throw new Error('No response body from OpenAI')
  }

  // Parse SSE stream from OpenAI with timeout protection
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulatedToolCall: any = {}
  let toolCallIndex: number | null = null

  // Streaming timeout: 280 seconds (leave 20s buffer for Vercel's 300s limit)
  const streamTimeout = 280000
  const startTime = Date.now()

  while (true) {
    // Check timeout
    if (Date.now() - startTime > streamTimeout) {
      console.error('Stream timeout exceeded, aborting')
      await reader.cancel()
      throw new Error('Stream timeout: Response took too long')
    }

    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.substring(6).trim()
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices[0]?.delta

          if (!delta) continue

          // Handle text chunks
          if (delta.content) {
            const shouldContinue = onChunk?.(delta.content)
            if (shouldContinue === false) {
              // Client disconnected, abort stream
              await reader.cancel()
              return { tokensUsed: undefined }
            }
          }

          // Handle tool calls
          if (delta.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              const index = toolCall.index
              if (index !== undefined) {
                toolCallIndex = index
                if (toolCall.function?.name) {
                  accumulatedToolCall.name = toolCall.function.name
                  accumulatedToolCall.arguments = ''
                }
                if (toolCall.function?.arguments) {
                  accumulatedToolCall.arguments = (accumulatedToolCall.arguments || '') + toolCall.function.arguments
                }
              }
            }
          }

          // Check if tool call is complete
          if (parsed.choices[0]?.finish_reason === 'tool_calls' && accumulatedToolCall.name) {
            try {
              const args = JSON.parse(accumulatedToolCall.arguments || '{}')
              const invocation = {
                id: `tool_${Date.now()}_${Math.random().toString(36).substring(7)}`,
                toolName: accumulatedToolCall.name,
                arguments: args,
                timestamp: new Date().toISOString()
              }
              onToolInvocation?.(invocation)
              accumulatedToolCall = {}
              toolCallIndex = null
            } catch (e) {
              console.error('Failed to parse tool arguments:', e)
            }
          }
        } catch (e) {
          console.error('Failed to parse SSE line:', e)
        }
      }
    }
  }

  return { tokensUsed: undefined } // OpenAI doesn't provide token count in streaming
}

// Helper function to stream from Anthropic
async function streamAnthropic(
  message: string,
  previousMessages: Message[],
  model?: string,
  tools?: Tool[],
  onChunk?: (chunk: string) => boolean | void, // Returns false to abort
  onToolInvocation?: (invocation: any) => void,
  userApiKey?: string
): Promise<{ tokensUsed?: number }> {
  const apiKey = userApiKey || process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('Anthropic API key not configured')
  }

  // Anthropic requires system message separately
  const systemMessage = previousMessages.find(m => m.role === 'system')
  const conversationMessages = previousMessages.filter(m => m.role !== 'system')

  // For regeneration requests (affirmation, focuses, capacity), the message is empty
  // and the actual prompt is in conversationMessages. Don't add empty user message.
  const messages = message.trim().length > 0
    ? [
        ...conversationMessages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: message }
      ]
    : conversationMessages.map(m => ({ role: m.role, content: m.content }))

  const requestBody: any = {
    model: model || 'claude-3-5-sonnet-20241022',
    max_tokens: 4096,
    messages,
    stream: true
  }

  if (systemMessage) {
    requestBody.system = systemMessage.content
  }

  if (tools && tools.length > 0) {
    requestBody.tools = tools.map(tool => {
      // Handle both OpenAI format (nested function) and direct format
      const toolData = tool.function || tool
      return {
        name: toolData.name,
        description: toolData.description,
        input_schema: toolData.parameters
      }
    })
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(`Anthropic API error: ${error.error?.message || response.statusText}`)
  }

  if (!response.body) {
    throw new Error('No response body from Anthropic')
  }

  // Parse SSE stream from Anthropic with timeout protection
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulatedToolUse: any = {}

  // Streaming timeout: 280 seconds (leave 20s buffer for Vercel's 300s limit)
  const streamTimeout = 280000
  const startTime = Date.now()

  while (true) {
    // Check timeout
    if (Date.now() - startTime > streamTimeout) {
      console.error('Stream timeout exceeded, aborting')
      await reader.cancel()
      throw new Error('Stream timeout: Response took too long')
    }

    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.substring(6).trim()

        try {
          const parsed = JSON.parse(data)

          // Handle text deltas
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            const shouldContinue = onChunk?.(parsed.delta.text)
            if (shouldContinue === false) {
              // Client disconnected, abort stream
              await reader.cancel()
              return { tokensUsed: undefined }
            }
          }

          // Handle tool use start
          if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
            accumulatedToolUse.name = parsed.content_block.name
            accumulatedToolUse.id = parsed.content_block.id
            accumulatedToolUse.input = ''
          }

          // Handle tool use delta
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
            accumulatedToolUse.input += parsed.delta.partial_json
          }

          // Handle tool use complete
          if (parsed.type === 'content_block_stop' && accumulatedToolUse.name) {
            try {
              const args = JSON.parse(accumulatedToolUse.input || '{}')
              const invocation = {
                id: accumulatedToolUse.id || `tool_${Date.now()}`,
                toolName: accumulatedToolUse.name,
                arguments: args,
                timestamp: new Date().toISOString()
              }
              onToolInvocation?.(invocation)
              accumulatedToolUse = {}
            } catch (e) {
              console.error('Failed to parse tool input:', e)
            }
          }
        } catch (e) {
          console.error('Failed to parse Anthropic SSE line:', e)
        }
      }
    }
  }

  return { tokensUsed: undefined }
}

// Helper function to get default model
function getDefaultModel(provider: string): string {
  return provider === 'openai' ? 'gpt-5.1' : 'claude-3-5-sonnet-20241022'
}

// Tracking functions
async function trackAIRequest(data: any) {
  try {
    await supabase.from('ai_usage').insert({
      user_id: data.userId,
      provider: data.provider,
      model: data.model,
      prompt_type: data.promptType,
      message_length: data.messageLength,
      request_id: data.requestId,
      session_id: data.context?.sessionId,
      coach_id: data.context?.coachId,
      feature_name: data.context?.featureName,
      event_type: 'request',
      created_at: new Date().toISOString()
    })
  } catch (error) {
    console.error('Failed to track AI request:', error)
  }
}

async function trackAIResponse(data: any) {
  try {
    await supabase.from('ai_usage').insert({
      user_id: data.userId,
      provider: data.provider,
      model: data.model,
      prompt_type: data.promptType,
      response_length: data.responseLength,
      tokens_used: data.tokensUsed,
      latency_ms: data.latencyMs,
      from_cache: data.fromCache,
      request_id: data.requestId,
      session_id: data.context?.sessionId,
      coach_id: data.context?.coachId,
      feature_name: data.context?.featureName,
      event_type: 'response',
      created_at: new Date().toISOString()
    })
  } catch (error) {
    console.error('Failed to track AI response:', error)
  }
}

async function trackAIError(data: any) {
  try {
    await supabase.from('ai_usage').insert({
      user_id: data.userId,
      provider: data.provider,
      model: data.model,
      prompt_type: data.promptType,
      error_type: data.errorType,
      error_message: data.errorMessage,
      error_code: data.errorCode,
      request_id: data.requestId,
      session_id: data.context?.sessionId,
      coach_id: data.context?.coachId,
      feature_name: data.context?.featureName,
      event_type: 'error',
      // Store additional context as JSON in error_message if needed
      stack_trace: data.stackTrace,
      created_at: new Date().toISOString()
    })
  } catch (error) {
    console.error('Failed to track AI error to Supabase:', error)
  }
}
