// Moltbook API client wrapper

import { MOLTBOOK_API_BASE } from '../config';
import type {
  MoltbookPost,
  MoltbookComment,
  MoltbookAgent,
  MoltbookFeedResponse,
  MoltbookSearchResponse,
  Submolt,
  CreatePostRequest,
  CreateCommentRequest,
  RateLimitInfo,
  UpvoteResponse,
  DMCheckResponse,
  DMRequest,
  DMConversation,
  DMMessage,
  GetMeResponse,
  CreatePostResponse,
} from './types';
import { safeD1Value } from '../utils/d1';

// Extract rate limit information from response headers
function extractRateLimits(response: Response): RateLimitInfo {
  // Parse reset - can be ISO date string or epoch seconds
  const resetHeader = response.headers.get('X-RateLimit-Reset') || '';
  let reset: number | undefined;
  if (resetHeader) {
    // Try parsing as ISO date first (e.g., "2026-02-04T09:05:04.000Z")
    const resetDate = new Date(resetHeader);
    if (!isNaN(resetDate.getTime())) {
      reset = Math.floor(resetDate.getTime() / 1000); // Convert to epoch seconds
    } else {
      // Fall back to parsing as number
      reset = parseInt(resetHeader) || undefined;
    }
  }

  return {
    limit: parseInt(response.headers.get('X-RateLimit-Limit') || '') || undefined,
    remaining: parseInt(response.headers.get('X-RateLimit-Remaining') || '') || undefined,
    reset,
    retryAfter: parseInt(response.headers.get('Retry-After') || '') || undefined,
  };
}

// Log rate limit observation to database
async function logRateLimitObservation(
  db: D1Database,
  endpoint: string,
  method: string,
  statusCode: number,
  rateLimitInfo: RateLimitInfo
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO rate_limit_observations
      (endpoint, method, status_code, rate_limit, rate_remaining, rate_reset, retry_after)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      endpoint,
      method,
      statusCode,
      safeD1Value(rateLimitInfo.limit ?? null),
      safeD1Value(rateLimitInfo.remaining ?? null),
      safeD1Value(rateLimitInfo.reset ?? null),
      safeD1Value(rateLimitInfo.retryAfter ?? null)
    ).run();
  } catch (error) {
    // Don't let logging failures break the main flow
    console.log('Rate limit logging failed:', error);
  }
}

export class RateLimitError extends Error {
  public retryAfter?: number;

  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class MoltbookClient {
  private apiKey: string;
  private baseUrl: string;
  private db?: D1Database;

  constructor(apiKey: string, baseUrl: string = MOLTBOOK_API_BASE, db?: D1Database) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.db = db;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAYS = [5000, 15000, 30000]; // 5s, 15s, 30s

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers,
        });

        // Success case
        if (response.ok) {
          // Extract and log rate limit info
          const rateLimitInfo = extractRateLimits(response);
          if (this.db) {
            await logRateLimitObservation(
              this.db,
              endpoint,
              options.method || 'GET',
              response.status,
              rateLimitInfo
            );
          }
          // Log to console for visibility during Phase 1 data collection
          if (rateLimitInfo.limit || rateLimitInfo.remaining) {
            console.log(`Rate limits [${endpoint}]: ${rateLimitInfo.remaining}/${rateLimitInfo.limit}`);
          }
          return response.json() as Promise<T>;
        }

        // Client errors (4xx) - don't retry
        if (response.status >= 400 && response.status < 500) {
          const errorText = await response.text();

          // Special handling for authentication errors (401)
          if (response.status === 401) {
            let errorData: any = null;
            try {
              errorData = JSON.parse(errorText);
            } catch {
              // JSON parsing failed, fall through to generic 401
            }

            if (errorData?.error === 'Account suspended') {
              const suspensionInfo = {
                reason: errorData.hint || 'Unknown',
                isSuspension: true
              };
              const error = new Error(`Moltbook account suspended: ${suspensionInfo.reason}`);
              (error as any).suspensionInfo = suspensionInfo;
              throw error;
            }

            // Regular 401 auth failure
            throw new Error(`Moltbook API error: 401 Unauthorized - Invalid API key`);
          }

          // Special handling for rate limits
          if (response.status === 429) {
            const rateLimitInfo = extractRateLimits(response);
            const retrySeconds = rateLimitInfo.retryAfter ?? 120; // Default 120s if unknown (Moltbook sends no Retry-After header)

            // Log 429 with full headers for debugging
            console.log(`Rate limited [${endpoint}]:`, JSON.stringify(rateLimitInfo));
            // Debug: log all response headers to discover actual header names
            const allHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              allHeaders[key] = value;
            });
            console.log(`All 429 headers [${endpoint}]:`, JSON.stringify(allHeaders));
            if (this.db) {
              await logRateLimitObservation(
                this.db,
                endpoint,
                options.method || 'GET',
                response.status,
                rateLimitInfo
              );
            }

            throw new RateLimitError(
              `Rate limited. Retry after ${retrySeconds}s.`,
              retrySeconds
            );
          }

          // Other 4xx errors - don't retry
          throw new Error(
            `Moltbook API error: ${response.status} ${response.statusText} - ${errorText}`
          );
        }

        // Server errors (5xx) - retry
        if (response.status >= 500) {
          const errorText = await response.text();
          lastError = new Error(
            `Moltbook API error: ${response.status} ${response.statusText} - ${errorText}`
          );

          // If not the last attempt, retry
          if (attempt < MAX_ATTEMPTS - 1) {
            const delay = RETRY_DELAYS[attempt];
            console.log(
              `Channel failed (${attempt + 1}/${MAX_ATTEMPTS}). Trying again in ${delay / 1000}s.`
            );
            await this.sleep(delay);
            continue;
          }

          // Last attempt, throw
          console.log(
            `Channel broke after ${MAX_ATTEMPTS} attempts.`
          );
          throw lastError;
        }

        // Unexpected status code
        const errorText = await response.text();
        throw new Error(
          `Moltbook API unexpected status: ${response.status} ${response.statusText} - ${errorText}`
        );

      } catch (error) {
        // Rate limit errors should NEVER be retried - throw immediately
        if (error instanceof RateLimitError) {
          throw error;
        }

        // If it's a Moltbook API error we threw, check if it's retryable
        if (error instanceof Error && error.message.startsWith('Moltbook API')) {
          // 4xx errors or unexpected status - don't retry
          if (!error.message.includes('Moltbook API error:') ||
              (error.message.includes('Moltbook API error:') && !lastError)) {
            throw error;
          }
          // 5xx errors already handled above, this rethrow is for last attempt
          throw error;
        }

        // Network/fetch error - retry
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < MAX_ATTEMPTS - 1) {
          const delay = RETRY_DELAYS[attempt];
          console.log(
            `Network broke (${attempt + 1}/${MAX_ATTEMPTS}). Trying again in ${delay / 1000}s.`
          );
          await this.sleep(delay);
          continue;
        }

        // Last attempt
        console.log(
          `Connection failed after ${MAX_ATTEMPTS} attempts.`
        );
        throw lastError;
      }
    }

    // This should never be reached, but TypeScript requires it
    throw lastError || new Error('Moltbook API request failed');
  }

  async getNewPosts(limit: number = 20): Promise<MoltbookPost[]> {
    const response = await this.request<MoltbookFeedResponse>(
      `/posts?sort=new&limit=${limit}`
    );
    return response.posts;
  }

  async getRisingPosts(limit: number = 10): Promise<MoltbookPost[]> {
    const response = await this.request<MoltbookFeedResponse>(
      `/posts?sort=rising&limit=${limit}`
    );
    return response.posts;
  }

  async searchPosts(query: string, limit: number = 20): Promise<MoltbookPost[]> {
    const encodedQuery = encodeURIComponent(query);
    const response = await this.request<MoltbookSearchResponse>(
      `/search?q=${encodedQuery}&type=posts&limit=${limit}`
    );
    return response.posts;
  }

  async getSubmoltFeed(submolt: string, sort: string = 'new', limit: number = 20): Promise<MoltbookPost[]> {
    const response = await this.request<MoltbookFeedResponse>(
      `/submolts/${submolt}/feed?sort=${sort}&limit=${limit}`
    );
    return response.posts;
  }

  async getPostComments(postId: string): Promise<MoltbookComment[]> {
    const response = await this.request<{ comments: MoltbookComment[] }>(
      `/posts/${postId}/comments`
    );
    return response.comments;
  }

  async postComment(postId: string, content: string, parentId?: string): Promise<MoltbookComment> {
    const body: CreateCommentRequest = { content };
    if (parentId) {
      body.parent_id = parentId;
    }
    return this.request<MoltbookComment>(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async createPost(title: string, content: string, submolt: string = 'general'): Promise<MoltbookPost> {
    const body: CreatePostRequest = { title, content, submolt };
    try {
      // API returns { success: boolean, post: MoltbookPost }
      const response = await this.request<CreatePostResponse>('/posts', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return response.post;
    } catch (error) {
      // Log actual error for debugging
      console.log(`createPost error for submolt "${submolt}":`, error instanceof Error ? error.message : error);

      // Only auto-create if error specifically mentions submolt not found
      // Previous check was too broad (matched any "not found")
      if (error instanceof Error &&
          (error.message.toLowerCase().includes(`submolt`) ||
           error.message.toLowerCase().includes(`"${submolt.toLowerCase()}"`) ||
           error.message.toLowerCase().includes(`'${submolt.toLowerCase()}'`)) &&
          error.message.toLowerCase().includes('not found')) {
        console.log(`Submolt ${submolt} not found. Creating it.`);
        await this.createSubmolt(submolt, `Community for ${submolt}`);
        const retryResponse = await this.request<CreatePostResponse>('/posts', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return retryResponse.post;
      }
      throw error;
    }
  }

  async getMe(): Promise<MoltbookAgent> {
    // API returns { success: boolean, agent: MoltbookAgent }
    const response = await this.request<GetMeResponse>('/agents/me');
    return response.agent;
  }

  /**
   * Set up owner email for Moltbook dashboard access
   * Required for new authentication system and bot management
   * @param email Owner email address (e.g., "hobbot@hob.farm")
   * @returns Success status and optional message
   */
  async setupOwnerEmail(email: string): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await this.request<{ success: boolean; message?: string }>(
        '/agents/me/setup-owner-email',
        {
          method: 'POST',
          body: JSON.stringify({ email })
        }
      );
      return response;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to setup owner email: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Verify API key is valid by checking /agents/me endpoint
   * Returns true if valid, throws error if invalid
   */
  async verifyApiKey(): Promise<{ valid: boolean; username?: string }> {
    try {
      const me = await this.getMe();
      return { valid: true, username: me.username };
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        return { valid: false };
      }
      // Re-throw network errors etc
      throw error;
    }
  }

  async getSubmolts(): Promise<Submolt[]> {
    return this.request<{ submolts: Submolt[] }>('/submolts')
      .then(response => response.submolts);
  }

  async createSubmolt(name: string, description: string): Promise<Submolt> {
    // Convert to Moltbook format: lowercase with hyphens
    const formattedName = name
      .replace(/([a-z])([A-Z])/g, '$1-$2')  // PascalCase to kebab
      .toLowerCase()
      .replace(/\s+/g, '-');  // spaces to hyphens

    return this.request<Submolt>('/submolts', {
      method: 'POST',
      body: JSON.stringify({
        name: formattedName,
        display_name: name,
        description
      }),
    });
  }

  async updateProfile(updates: Partial<MoltbookAgent>): Promise<MoltbookAgent> {
    return this.request<MoltbookAgent>('/agents/me', {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  // ============================================
  // Subscription Management
  // ============================================

  async subscribe(submolt: string): Promise<void> {
    await this.request<{ success: boolean }>(`/submolts/${submolt}/subscribe`, {
      method: 'POST',
    });
  }

  async unsubscribe(submolt: string): Promise<void> {
    await this.request<{ success: boolean }>(`/submolts/${submolt}/subscribe`, {
      method: 'DELETE',
    });
  }

  // ============================================
  // Personalized Feed
  // ============================================

  async getFeed(sort: 'hot' | 'new' | 'top' = 'new', limit: number = 25): Promise<MoltbookPost[]> {
    const response = await this.request<MoltbookFeedResponse>(
      `/feed?sort=${sort}&limit=${limit}`
    );
    return response.posts;
  }

  // ============================================
  // Voting
  // ============================================

  async upvotePost(postId: string): Promise<UpvoteResponse> {
    return this.request<UpvoteResponse>(`/posts/${postId}/upvote`, {
      method: 'POST',
    });
  }

  async downvotePost(postId: string): Promise<void> {
    await this.request<{ success: boolean }>(`/posts/${postId}/downvote`, {
      method: 'POST',
    });
  }

  async upvoteComment(commentId: string): Promise<void> {
    await this.request<{ success: boolean }>(`/comments/${commentId}/upvote`, {
      method: 'POST',
    });
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.request<{ success: boolean }>(`/comments/${commentId}`, {
      method: 'DELETE',
    });
  }

  async deletePost(postId: string): Promise<void> {
    await this.request<{ success: boolean }>(`/posts/${postId}`, {
      method: 'DELETE',
    });
  }

  // ============================================
  // Following
  // ============================================

  async follow(agentName: string): Promise<void> {
    await this.request<{ success: boolean }>(`/agents/${agentName}/follow`, {
      method: 'POST',
    });
  }

  async unfollow(agentName: string): Promise<void> {
    await this.request<{ success: boolean }>(`/agents/${agentName}/follow`, {
      method: 'DELETE',
    });
  }

  async getProfile(name: string): Promise<MoltbookAgent> {
    return this.request<MoltbookAgent>(`/agents/profile?name=${encodeURIComponent(name)}`);
  }

  // ============================================
  // Direct Messages (DMs)
  // ============================================

  async checkDMs(): Promise<DMCheckResponse> {
    return this.request<DMCheckResponse>('/agents/dm/check');
  }

  async getDMRequests(): Promise<DMRequest[]> {
    const response = await this.request<{ requests: DMRequest[] }>('/agents/dm/requests');
    return response.requests;
  }

  async approveDMRequest(conversationId: string): Promise<void> {
    await this.request<{ success: boolean }>(`/agents/dm/requests/${conversationId}/approve`, {
      method: 'POST',
    });
  }

  async rejectDMRequest(conversationId: string, block: boolean = false): Promise<void> {
    await this.request<{ success: boolean }>(`/agents/dm/requests/${conversationId}/reject`, {
      method: 'POST',
      body: block ? JSON.stringify({ block: true }) : undefined,
    });
  }

  async getConversations(): Promise<DMConversation[]> {
    const response = await this.request<{ conversations: DMConversation[] }>('/agents/dm/conversations');
    return response.conversations;
  }

  async getConversation(conversationId: string): Promise<DMMessage[]> {
    const response = await this.request<{ messages: DMMessage[] }>(`/agents/dm/conversations/${conversationId}`);
    return response.messages;
  }

  async sendMessage(conversationId: string, message: string, needsHumanInput: boolean = false): Promise<void> {
    const body: { message: string; needs_human_input?: boolean } = { message };
    if (needsHumanInput) {
      body.needs_human_input = true;
    }
    await this.request<{ success: boolean }>(`/agents/dm/conversations/${conversationId}/send`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}
