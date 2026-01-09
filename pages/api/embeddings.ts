import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 100; // 100 requests per minute
const MAX_TEXTS_PER_REQUEST = 100; // Max batch size

// Simple in-memory cache for embeddings (7 days TTL)
const embeddingCache = new Map<string, { embedding: number[]; timestamp: number }>();
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

interface EmbeddingRequest {
  texts: string[];
  model?: string;
  userId?: string;
}

interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

interface ErrorResponse {
  error: string;
  details?: string;
}

/**
 * Generate embeddings for text using OpenAI's text-embedding-3-small model
 * Includes authentication, rate limiting, and caching
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<EmbeddingResponse | ErrorResponse>
) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Extract request data
    const { texts, model = 'text-embedding-3-small', userId }: EmbeddingRequest = req.body;

    // Validate input
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      return res.status(400).json({ 
        error: 'Invalid request', 
        details: 'texts must be a non-empty array' 
      });
    }

    if (texts.length > MAX_TEXTS_PER_REQUEST) {
      return res.status(400).json({ 
        error: 'Too many texts', 
        details: `Maximum ${MAX_TEXTS_PER_REQUEST} texts per request` 
      });
    }

    // Validate text content
    for (const text of texts) {
      if (typeof text !== 'string' || text.trim().length === 0) {
        return res.status(400).json({ 
          error: 'Invalid text', 
          details: 'All texts must be non-empty strings' 
        });
      }
    }

    // Authentication check (optional - can be made required)
    const authHeader = req.headers.authorization;
    let authenticatedUserId: string | null = null;

    if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error } = await supabase.auth.getUser(token);
      
      if (error || !user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      authenticatedUserId = user.id;
    }

    // Use authenticated user ID or provided user ID
    const effectiveUserId = authenticatedUserId || userId || 'anonymous';

    // Rate limiting check
    const rateLimitKey = `embedding_rate_limit:${effectiveUserId}`;
    const now = Date.now();
    
    // Check rate limit in Supabase (or use Redis in production)
    const { data: rateLimitData } = await supabase
      .from('rate_limits')
      .select('request_count, window_start')
      .eq('user_id', effectiveUserId)
      .eq('endpoint', 'embeddings')
      .single();

    if (rateLimitData) {
      const windowStart = new Date(rateLimitData.window_start).getTime();
      const isWithinWindow = now - windowStart < RATE_LIMIT_WINDOW;

      if (isWithinWindow && rateLimitData.request_count >= MAX_REQUESTS_PER_WINDOW) {
        return res.status(429).json({ 
          error: 'Rate limit exceeded', 
          details: 'Too many requests. Please try again later.' 
        });
      }

      // Update or reset rate limit
      if (isWithinWindow) {
        await supabase
          .from('rate_limits')
          .update({ request_count: rateLimitData.request_count + 1 })
          .eq('user_id', effectiveUserId)
          .eq('endpoint', 'embeddings');
      } else {
        await supabase
          .from('rate_limits')
          .update({ request_count: 1, window_start: new Date(now).toISOString() })
          .eq('user_id', effectiveUserId)
          .eq('endpoint', 'embeddings');
      }
    } else {
      // Create new rate limit entry
      await supabase
        .from('rate_limits')
        .insert({
          user_id: effectiveUserId,
          endpoint: 'embeddings',
          request_count: 1,
          window_start: new Date(now).toISOString(),
        });
    }

    // Check cache and prepare texts for embedding
    const embeddings: number[][] = [];
    const textsToEmbed: string[] = [];
    const cacheHits: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i].trim();
      const cacheKey = `${model}:${text}`;
      const cached = embeddingCache.get(cacheKey);

      if (cached && now - cached.timestamp < CACHE_TTL) {
        // Use cached embedding
        embeddings[i] = cached.embedding;
        cacheHits.push(i);
      } else {
        // Need to generate embedding
        textsToEmbed.push(text);
        embeddings[i] = []; // Placeholder
      }
    }

    let totalTokens = 0;
    let promptTokens = 0;

    // Generate embeddings for non-cached texts
    if (textsToEmbed.length > 0) {
      const response = await openai.embeddings.create({
        model: model,
        input: textsToEmbed,
      });

      // Fill in the embeddings
      let embeddingIndex = 0;
      for (let i = 0; i < texts.length; i++) {
        if (!cacheHits.includes(i)) {
          const embedding = response.data[embeddingIndex].embedding;
          embeddings[i] = embedding;

          // Cache the embedding
          const cacheKey = `${model}:${texts[i].trim()}`;
          embeddingCache.set(cacheKey, { embedding, timestamp: now });

          embeddingIndex++;
        }
      }

      totalTokens = response.usage.total_tokens;
      promptTokens = response.usage.prompt_tokens;
    }

    // Clean up old cache entries periodically (every 100 requests)
    if (Math.random() < 0.01) {
      for (const [key, value] of embeddingCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
          embeddingCache.delete(key);
        }
      }
    }

    // Log usage to Supabase
    if (authenticatedUserId) {
      await supabase.from('embedding_usage').insert({
        user_id: authenticatedUserId,
        model: model,
        text_count: texts.length,
        cache_hits: cacheHits.length,
        prompt_tokens: promptTokens,
        total_tokens: totalTokens,
        created_at: new Date().toISOString(),
      });
    }

    // Return embeddings
    return res.status(200).json({
      embeddings,
      model,
      usage: {
        prompt_tokens: promptTokens,
        total_tokens: totalTokens,
      },
    });

  } catch (error: any) {
    console.error('Embedding generation error:', error);
    
    // Handle OpenAI API errors
    if (error.status === 429) {
      return res.status(429).json({ 
        error: 'OpenAI rate limit exceeded', 
        details: 'Please try again later' 
      });
    }

    if (error.status === 401) {
      return res.status(500).json({ 
        error: 'OpenAI API authentication failed', 
        details: 'Invalid API key' 
      });
    }

    return res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
}
