/**
 * OpenRouter API Client
 * Direct integration with OpenRouter API using OpenAI-compatible format
 */

import { getModelId, getModel, isImageGenModel, DEFAULT_IMAGE_MODEL, usesDirectApi, getDirectApiProvider } from './models';
import { AVAILABLE_TOOLS, executeTool, type ToolDefinition, type ToolCall, type ToolResult, type ToolContext } from './tools';
import { DirectApiClient, type DirectApiKeys } from './direct-api';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string; // base64 data URL or regular URL
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
}

export interface ImageGenerationResponse {
  created: number;
  data: Array<{
    url?: string;
    b64_json?: string;
  }>;
}

export interface OpenRouterError {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

/**
 * OpenRouter API Client
 */
export class OpenRouterClient {
  private apiKey: string;
  private siteUrl?: string;
  private siteName?: string;
  private directApiClient?: DirectApiClient;

  constructor(apiKey: string, options?: { siteUrl?: string; siteName?: string; directApiKeys?: DirectApiKeys }) {
    this.apiKey = apiKey;
    this.siteUrl = options?.siteUrl;
    this.siteName = options?.siteName || 'Moltworker Bot';
    if (options?.directApiKeys) {
      this.directApiClient = new DirectApiClient(options.directApiKeys);
    }
  }

  /**
   * Set direct API keys (can be called after construction)
   */
  setDirectApiKeys(keys: DirectApiKeys): void {
    this.directApiClient = new DirectApiClient(keys);
  }

  /**
   * Get headers for OpenRouter API
   */
  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.siteUrl || 'https://github.com/PetrAnto/moltworker',
      'X-Title': this.siteName || 'Moltworker Bot',
    };
    return headers;
  }

  /**
   * Send a chat completion request
   */
  async chatCompletion(
    modelAlias: string,
    messages: ChatMessage[],
    options?: {
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<ChatCompletionResponse> {
    // Check if this model uses a direct API
    if (usesDirectApi(modelAlias)) {
      if (!this.directApiClient) {
        throw new Error(`Direct API keys not configured. Set DASHSCOPE_API_KEY, MOONSHOT_API_KEY, or DEEPSEEK_API_KEY.`);
      }
      return this.directApiClient.chatCompletion(modelAlias, messages, options);
    }

    const modelId = getModelId(modelAlias);

    const request: ChatCompletionRequest = {
      model: modelId,
      messages,
      max_tokens: options?.maxTokens || 4096,
      temperature: options?.temperature ?? 0.7,
    };

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json() as OpenRouterError;
      throw new Error(`OpenRouter API error: ${error.error?.message || response.statusText}`);
    }

    return response.json() as Promise<ChatCompletionResponse>;
  }

  /**
   * Send a chat completion with tool calling support
   * Handles the tool call loop automatically with timeout protection
   */
  async chatCompletionWithTools(
    modelAlias: string,
    messages: ChatMessage[],
    options?: {
      maxTokens?: number;
      temperature?: number;
      maxToolCalls?: number; // Limit iterations to prevent infinite loops
      maxTimeMs?: number; // Maximum time in ms before returning partial result
      onToolCall?: (toolName: string, args: string) => void; // Callback for progress updates
      onIteration?: (iteration: number, totalTools: number) => void; // Callback for iteration progress
      toolContext?: ToolContext; // Context with secrets for tool execution
    }
  ): Promise<{ response: ChatCompletionResponse; finalText: string; toolsUsed: string[]; hitLimit: boolean }> {
    const isDirectApi = usesDirectApi(modelAlias);
    const modelId = getModelId(modelAlias);
    const maxIterations = options?.maxToolCalls || 10;
    const maxTimeMs = options?.maxTimeMs || 120000; // Default 2 minutes for paid Workers plan
    const startTime = Date.now();
    const toolsUsed: string[] = [];
    let hitLimit = false;

    // Check direct API availability
    if (isDirectApi && !this.directApiClient) {
      throw new Error(`Direct API keys not configured. Set DASHSCOPE_API_KEY, MOONSHOT_API_KEY, or DEEPSEEK_API_KEY.`);
    }

    // Clone messages to avoid mutating the original
    const conversationMessages: ChatMessage[] = [...messages];

    let iterations = 0;
    let lastResponse: ChatCompletionResponse;

    while (iterations < maxIterations) {
      // Check time limit
      if (Date.now() - startTime > maxTimeMs) {
        hitLimit = true;
        break;
      }

      iterations++;

      // Notify about iteration
      if (options?.onIteration) {
        options.onIteration(iterations, toolsUsed.length);
      }

      // Route to direct API or OpenRouter
      if (isDirectApi) {
        lastResponse = await this.directApiClient!.chatCompletionWithTools(
          modelAlias,
          conversationMessages,
          AVAILABLE_TOOLS,
          { maxTokens: options?.maxTokens, temperature: options?.temperature }
        );
      } else {
        const request: ChatCompletionRequest = {
          model: modelId,
          messages: conversationMessages,
          max_tokens: options?.maxTokens || 4096,
          temperature: options?.temperature ?? 0.7,
          tools: AVAILABLE_TOOLS,
          tool_choice: 'auto',
        };

        const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify(request),
        });

        if (!response.ok) {
          const error = await response.json() as OpenRouterError;
          throw new Error(`OpenRouter API error: ${error.error?.message || response.statusText}`);
        }

        lastResponse = await response.json() as ChatCompletionResponse;
      }
      const choice = lastResponse.choices[0];

      // Check if the model wants to call tools
      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        // Check time before executing tools
        if (Date.now() - startTime > maxTimeMs - 5000) { // Leave 5s buffer
          hitLimit = true;
          break;
        }

        // Add assistant message with tool calls to conversation
        conversationMessages.push({
          role: 'assistant',
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
        });

        // Execute each tool call
        for (const toolCall of choice.message.tool_calls) {
          const toolName = toolCall.function.name;
          toolsUsed.push(toolName);

          // Notify caller about tool call
          if (options?.onToolCall) {
            options.onToolCall(toolName, toolCall.function.arguments);
          }

          // Execute tool and get result (pass context with secrets)
          const result = await executeTool(toolCall, options?.toolContext);

          // Add tool result to conversation
          conversationMessages.push({
            role: 'tool',
            content: result.content,
            tool_call_id: result.tool_call_id,
          });
        }

        // Continue the loop to get the model's response to tool results
        continue;
      }

      // No more tool calls, model has finished
      break;
    }

    // Check if we hit the iteration limit
    if (iterations >= maxIterations) {
      hitLimit = true;
    }

    // Extract final text response
    const finalText = lastResponse!.choices[0]?.message?.content || 'No response generated.';

    return {
      response: lastResponse!,
      finalText,
      toolsUsed,
      hitLimit,
    };
  }

  /**
   * Send a chat completion with vision (image input)
   */
  async chatCompletionWithVision(
    modelAlias: string,
    textPrompt: string,
    imageBase64: string,
    mimeType: string = 'image/jpeg'
  ): Promise<ChatCompletionResponse> {
    const modelId = getModelId(modelAlias);

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: textPrompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${imageBase64}`,
            },
          },
        ],
      },
    ];

    const request: ChatCompletionRequest = {
      model: modelId,
      messages,
      max_tokens: 4096,
    };

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json() as OpenRouterError;
      throw new Error(`OpenRouter API error: ${error.error?.message || response.statusText}`);
    }

    return response.json() as Promise<ChatCompletionResponse>;
  }

  /**
   * Generate an image using FLUX or other image models
   * Uses OpenRouter's chat/completions with modalities: ["image", "text"]
   */
  async generateImage(
    prompt: string,
    modelAlias?: string,
    options?: {
      aspectRatio?: string; // e.g., "1:1", "16:9", "9:16"
      imageSize?: string; // e.g., "1024x1024"
    }
  ): Promise<ImageGenerationResponse> {
    // Use specified model or default to fluxpro
    const alias = modelAlias || DEFAULT_IMAGE_MODEL;
    const modelId = getModelId(alias);

    // OpenRouter uses chat/completions with modalities for image generation
    const request: Record<string, unknown> = {
      model: modelId,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      modalities: ['image', 'text'],
      max_tokens: 4096,
    };

    // Add image config if specified
    if (options?.aspectRatio || options?.imageSize) {
      request.image_config = {
        ...(options.aspectRatio && { aspect_ratio: options.aspectRatio }),
        ...(options.imageSize && { image_size: options.imageSize }),
      };
    }

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage: string;
      try {
        const error = JSON.parse(errorText) as OpenRouterError;
        errorMessage = error.error?.message || response.statusText;
      } catch {
        errorMessage = errorText || response.statusText;
      }
      throw new Error(`Image generation error: ${errorMessage}`);
    }

    const chatResponse = await response.json() as ChatCompletionResponse;

    // Extract image URL from the response content
    // OpenRouter returns images as base64 data URLs in the message content
    const content = chatResponse.choices[0]?.message?.content || '';

    // Parse the content - it may contain markdown image syntax or direct URL
    // Format: ![image](data:image/png;base64,...) or just the data URL
    const imageMatch = content.match(/!\[.*?\]\((data:image\/[^)]+)\)/) ||
                       content.match(/(data:image\/[^\s"']+)/) ||
                       content.match(/(https:\/\/[^\s"']+\.(png|jpg|jpeg|webp))/i);

    if (imageMatch) {
      return {
        created: Date.now(),
        data: [{ url: imageMatch[1] }],
      };
    }

    // If no image URL found, return the text content as an error indicator
    return {
      created: Date.now(),
      data: [],
    };
  }

  /**
   * Stream a chat completion (returns ReadableStream)
   */
  async chatCompletionStream(
    modelAlias: string,
    messages: ChatMessage[],
    options?: {
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<ReadableStream<Uint8Array>> {
    const modelId = getModelId(modelAlias);

    const request: ChatCompletionRequest = {
      model: modelId,
      messages,
      max_tokens: options?.maxTokens || 4096,
      temperature: options?.temperature ?? 0.7,
      stream: true,
    };

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json() as OpenRouterError;
      throw new Error(`OpenRouter API error: ${error.error?.message || response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    return response.body;
  }

  /**
   * Get available models from OpenRouter
   */
  async listModels(): Promise<unknown> {
    const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Check API key validity and get credits
   */
  async getCredits(): Promise<{ credits: number; usage: number }> {
    const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get credits: ${response.statusText}`);
    }

    const data = await response.json() as { data: { label: string; usage: number; limit: number } };
    return {
      credits: data.data.limit - data.data.usage,
      usage: data.data.usage,
    };
  }
}

/**
 * Create an OpenRouter client from environment
 */
export function createOpenRouterClient(
  apiKey: string,
  workerUrl?: string,
  directApiKeys?: DirectApiKeys
): OpenRouterClient {
  return new OpenRouterClient(apiKey, {
    siteUrl: workerUrl,
    siteName: 'Moltworker Telegram Bot',
    directApiKeys,
  });
}

// Re-export DirectApiKeys type for consumers
export type { DirectApiKeys } from './direct-api';

/**
 * Extract text response from chat completion
 */
export function extractTextResponse(response: ChatCompletionResponse): string {
  return response.choices[0]?.message?.content || 'No response generated.';
}
