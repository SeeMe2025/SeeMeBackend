import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface Tool {
  name: string
  description: string
  parameters: any
}

interface AIGatewayRequest {
  message: string
  previousMessages: Message[]
  promptType: string
  provider?: 'openai' | 'anthropic'
  model?: string
  stream?: boolean
  tools?: Tool[]
  context?: {
    userId?: string
    sessionId?: string
    coachId?: string
    featureName?: string
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
    // Extract user token from Authorization header
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' })
    }

    const userToken = authHeader.substring(7)

    // Verify token with Supabase
    const { data: { user }, error: authError } = await supabase.auth.getUser(userToken)
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid authentication token' })
    }

    // Parse request body
    const body: AIGatewayRequest = req.body
    const {
      message,
      previousMessages = [],
      promptType,
      provider = 'openai',
      model,
      stream = false,
      tools = [],
      context = {}
    } = body

    if (!message) {
      return res.status(400).json({ error: 'Message is required' })
    }

    // Rate limiting check (simple implementation - 20 requests per minute)
    const rateLimitKey = `rate_limit:${user.id}`
    const now = Date.now()
    const windowMs = 60 * 1000 // 1 minute

    // TODO: Implement proper rate limiting with Redis or similar
    // For now, we'll skip rate limiting and add it later

    // Generate request ID
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`

    // Log AI request to Supabase
    const startTime = Date.now()
    await trackAIRequest({
      userId: user.id,
      provider,
      model: model || getDefaultModel(provider),
      promptType,
      messageLength: message.length,
      requestId,
      context
    })

    // Call appropriate AI provider
    let response: any
    let tokensUsed: number | undefined

    if (provider === 'openai') {
      const result = await callOpenAI(message, previousMessages, model, tools, stream)
      response = result.content
      tokensUsed = result.tokensUsed
    } else if (provider === 'anthropic') {
      const result = await callAnthropic(message, previousMessages, model, tools, stream)
      response = result.content
      tokensUsed = result.tokensUsed
    } else {
      return res.status(400).json({ error: 'Invalid provider' })
    }

    const latencyMs = Date.now() - startTime

    // Log AI response to Supabase
    await trackAIResponse({
      userId: user.id,
      provider,
      model: model || getDefaultModel(provider),
      promptType,
      responseLength: response.length,
      tokensUsed,
      latencyMs,
      fromCache: false,
      requestId,
      context
    })

    // Return response
    return res.status(200).json({
      content: response,
      provider,
      model: model || getDefaultModel(provider),
      tokensUsed,
      fromCache: false,
      requestId,
      latencyMs
    })

  } catch (error: any) {
    console.error('AI Gateway Error:', error)

    // Log error to Supabase
    try {
      await trackAIError({
        userId: req.body.context?.userId || 'unknown',
        provider: req.body.provider || 'unknown',
        promptType: req.body.promptType || 'unknown',
        errorType: error.name || 'unknown_error',
        errorMessage: error.message || 'Unknown error occurred',
        requestId: `req_${Date.now()}_error`
      })
    } catch (logError) {
      console.error('Failed to log error:', logError)
    }

    return res.status(500).json({
      error: error.message || 'Internal server error',
      requestId: `req_${Date.now()}_error`
    })
  }
}

// Helper function to call OpenAI
async function callOpenAI(
  message: string,
  previousMessages: Message[],
  model?: string,
  tools?: Tool[],
  stream?: boolean
): Promise<{ content: string; tokensUsed?: number }> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OpenAI API key not configured')
  }

  const messages = [
    ...previousMessages.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message }
  ]

  const requestBody: any = {
    model: model || 'gpt-4o',
    messages,
    stream: stream || false
  }

  if (tools && tools.length > 0) {
    requestBody.tools = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }))
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

  const data = await response.json()

  return {
    content: data.choices[0].message.content || '',
    tokensUsed: data.usage?.total_tokens
  }
}

// Helper function to call Anthropic
async function callAnthropic(
  message: string,
  previousMessages: Message[],
  model?: string,
  tools?: Tool[],
  stream?: boolean
): Promise<{ content: string; tokensUsed?: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('Anthropic API key not configured')
  }

  // Anthropic requires system message separately
  const systemMessage = previousMessages.find(m => m.role === 'system')
  const conversationMessages = previousMessages.filter(m => m.role !== 'system')

  const messages = [
    ...conversationMessages.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message }
  ]

  const requestBody: any = {
    model: model || 'claude-3-5-sonnet-20241022',
    max_tokens: 4096,
    messages
  }

  if (systemMessage) {
    requestBody.system = systemMessage.content
  }

  if (tools && tools.length > 0) {
    requestBody.tools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }))
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

  const data = await response.json()

  return {
    content: data.content[0].text || '',
    tokensUsed: data.usage?.input_tokens + data.usage?.output_tokens
  }
}

// Helper function to get default model
function getDefaultModel(provider: string): string {
  return provider === 'openai' ? 'gpt-4o' : 'claude-3-5-sonnet-20241022'
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
      prompt_type: data.promptType,
      error_type: data.errorType,
      error_message: data.errorMessage,
      request_id: data.requestId,
      event_type: 'error',
      created_at: new Date().toISOString()
    })
  } catch (error) {
    console.error('Failed to track AI error:', error)
  }
}
