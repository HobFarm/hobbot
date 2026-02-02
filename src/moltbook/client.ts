// Moltbook API client wrapper

import { MOLTBOOK_API_BASE } from '../config';
import type {
  MoltbookPost,
  MoltbookComment,
  MoltbookAgent,
  MoltbookFeedResponse,
  MoltbookSearchResponse,
  CreatePostRequest,
  CreateCommentRequest,
} from './types';

export class MoltbookClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl: string = MOLTBOOK_API_BASE) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Moltbook API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    return response.json() as Promise<T>;
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

  async postComment(postId: string, content: string): Promise<MoltbookComment> {
    const body: CreateCommentRequest = { content };
    return this.request<MoltbookComment>(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async createPost(title: string, content: string, submolt: string = 'general'): Promise<MoltbookPost> {
    const body: CreatePostRequest = { title, content, submolt };
    return this.request<MoltbookPost>('/posts', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getMe(): Promise<MoltbookAgent> {
    return this.request<MoltbookAgent>('/agents/me');
  }

  async updateProfile(updates: Partial<MoltbookAgent>): Promise<MoltbookAgent> {
    return this.request<MoltbookAgent>('/agents/me', {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }
}
