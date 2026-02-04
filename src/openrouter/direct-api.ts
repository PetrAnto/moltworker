/**
 * Direct API Client for Vendor APIs
 * Supports: DashScope (Qwen), Moonshot (Kimi), DeepSeek
 *
 * These APIs are OpenAI-compatible, so we use a similar interface.
 */

import type { ChatMessage, ChatCompletionResponse } from './client';
import { getModel, getModelId } from './models';

// API Base URLs
const API_ENDPOINTS = {
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  deepseek: 'https://api.deepseek.com/v1',
} as const;

export type DirectApiProvider = keyof typeof API_ENDPOINTS;

export interface DirectApiKeys {
  dashscope?: string;  // DASHSCOPE_API_KEY
  moonshot?: string;   // MOONSHOT_API_KEY
  deepseek?: string;   // DEEPSEEK_API_KEY
}

/**
 * Direct API Client for vendor APIs
 */
export class DirectApiClient {
  private keys: DirectApiKeys;

  constructor(keys: DirectApiKeys) {
    this.keys = keys;
  }

  /**
   * Check if we have the API key for a provider
   */
  hasKey(provider: DirectApiProvider): boolean {
    return !!this.keys[provider];
  }

  /**
   * Get the API key for a provider
   */
  private getKey(provider: DirectApiProvider): string {
    const key = this.keys[provider];
    if (!key) {
      throw new Error(`No API key configured for ${provider}. Add ${provider.toUpperCase()}_API_KEY to your environment.`);
    }
    return key;
  }

  /**
   * Send a chat completion request to a direct API
   */
  async chatCompletion(
    modelAlias: string,
    messages: ChatMessage[],
    options?: {
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<ChatCompletionResponse> {
    const model = getModel(modelAlias);
    if (!model?.directApi) {
      throw new Error(`Model ${modelAlias} is not a direct API model`);
    }

    const provider = model.directApi;
    const apiKey = this.getKey(provider);
    const baseUrl = API_ENDPOINTS[provider];
    const modelId = model.id;

    const request = {
      model: modelId,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: options?.maxTokens || 4096,
      temperature: options?.temperature ?? 0.7,
    };

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage: string;
      try {
        const error = JSON.parse(errorText);
        errorMessage = error.error?.message || error.message || response.statusText;
      } catch {
        errorMessage = errorText || response.statusText;
      }
      throw new Error(`${provider} API error: ${errorMessage}`);
    }

    return response.json() as Promise<ChatCompletionResponse>;
  }

  /**
   * Send a chat completion with tool calling support
   * Note: Tool support varies by provider
   */
  async chatCompletionWithTools(
    modelAlias: string,
    messages: ChatMessage[],
    tools: unknown[],
    options?: {
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<ChatCompletionResponse> {
    const model = getModel(modelAlias);
    if (!model?.directApi) {
      throw new Error(`Model ${modelAlias} is not a direct API model`);
    }

    const provider = model.directApi;
    const apiKey = this.getKey(provider);
    const baseUrl = API_ENDPOINTS[provider];
    const modelId = model.id;

    const request = {
      model: modelId,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls && { tool_calls: m.tool_calls }),
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
      })),
      max_tokens: options?.maxTokens || 4096,
      temperature: options?.temperature ?? 0.7,
      tools,
      tool_choice: 'auto',
    };

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage: string;
      try {
        const error = JSON.parse(errorText);
        errorMessage = error.error?.message || error.message || response.statusText;
      } catch {
        errorMessage = errorText || response.statusText;
      }
      throw new Error(`${provider} API error: ${errorMessage}`);
    }

    return response.json() as Promise<ChatCompletionResponse>;
  }
}

/**
 * Create a direct API client from environment keys
 */
export function createDirectApiClient(keys: DirectApiKeys): DirectApiClient {
  return new DirectApiClient(keys);
}
