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
      tools = [],
      context = {}
    } = body

    if (!message) {
      return res.status(400).json({ error: 'Message is required' })
    }

    // Generate request ID
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`
    const startTime = Date.now()

    // Log AI request to Supabase
    await trackAIRequest({
      userId: user.id,
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
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`)
          return true
        },
        (toolInvocation) => {
          if (isClientConnected) {
            res.write(`data: ${JSON.stringify({ toolInvocation })}\n\n`)
          }
        }
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
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`)
          return true
        },
        (toolInvocation) => {
          if (isClientConnected) {
            res.write(`data: ${JSON.stringify({ toolInvocation })}\n\n`)
          }
        }
      )
      tokensUsed = result.tokensUsed
    }

    // Send completion event if client still connected
    if (isClientConnected && !streamAborted) {
      res.write(`data: [DONE]\n\n`)
    }

    const latencyMs = Date.now() - startTime
    const fullResponse = responseChunks.join('') // Efficient join at the end

    // Log AI response to Supabase (even if client disconnected, for analytics)
    await trackAIResponse({
      userId: user.id,
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
        userId: req.body.context?.userId || 'unknown',
        sessionId: req.body.context?.sessionId,
        coachId: req.body.context?.coachId
      }
    }

    // Send structured error event to Swift app
    res.write(`data: ${JSON.stringify(errorResponse)}\n\n`)
    res.end()

    // Log detailed error to Supabase
    try {
      await trackAIError({
        userId: req.body.context?.userId || 'unknown',
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
  onToolInvocation?: (invocation: any) => void
): Promise<{ tokensUsed?: number }> {
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
    stream: true
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
  onToolInvocation?: (invocation: any) => void
): Promise<{ tokensUsed?: number }> {
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
