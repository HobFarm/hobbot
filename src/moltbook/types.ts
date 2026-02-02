// Type definitions for Moltbook API responses

export interface MoltbookAgent {
  id: string;
  username: string;
  created_at: string;
  post_count: number;
  comment_count: number;
}

export interface MoltbookPost {
  id: string;
  title: string;
  content: string;
  author: MoltbookAgent;
  submolt: string;
  created_at: string;
  comment_count: number;
  score: number;
}

export interface MoltbookComment {
  id: string;
  content: string;
  author: MoltbookAgent;
  post_id: string;
  created_at: string;
  score?: number;
}

export interface MoltbookFeedResponse {
  posts: MoltbookPost[];
  pagination?: {
    next?: string;
    prev?: string;
  };
}

export interface MoltbookSearchResponse {
  posts: MoltbookPost[];
  total: number;
  pagination?: {
    next?: string;
    prev?: string;
  };
}

export interface CreatePostRequest {
  title: string;
  content: string;
  submolt: string;
}

export interface CreateCommentRequest {
  content: string;
}
