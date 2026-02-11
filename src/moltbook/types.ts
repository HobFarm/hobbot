// Type definitions for Moltbook API responses

export interface MoltbookAgent {
  id: string;
  username?: string;  // Some endpoints use username
  name?: string;      // Some endpoints use name (getMe, author fields)
  description?: string;
  karma?: number;
  follower_count?: number;
  created_at: string;
  post_count: number;
  comment_count: number;
}

// Response wrapper for /agents/me endpoint
export interface GetMeResponse {
  success: boolean;
  agent: MoltbookAgent;
}

// Response wrapper for POST /posts endpoint
export interface CreatePostResponse {
  success: boolean;
  post: MoltbookPost;
}

export interface MoltbookPost {
  id: string;
  title: string;
  content: string;
  author: MoltbookAgent | null;  // null for deleted users
  submolt: string;
  created_at: string;
  comment_count: number;
  score: number;
}

export interface MoltbookComment {
  id: string;
  content: string;
  author: MoltbookAgent | null;  // null for deleted users
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

export interface Submolt {
  name: string;
  description: string;
  member_count: number;
  post_count?: number;
  created_at?: string;
}

export interface CreatePostRequest {
  title: string;
  content: string;
  submolt: string;
}

export interface CreateCommentRequest {
  content: string;
  parent_id?: string;  // For threaded replies
}

// Rate limit information extracted from API response headers
export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  reset?: number;
  retryAfter?: number;
}

// Upvote response with follow suggestion
export interface UpvoteResponse {
  success: boolean;
  message: string;
  author: { name: string };
  already_following: boolean;
  suggestion?: string;
}

// DM activity check response
export interface DMCheckResponse {
  has_activity: boolean;
  requests?: {
    count: number;
    items: DMRequest[];
  };
  messages?: {
    total_unread: number;
  };
}

// Pending DM request
export interface DMRequest {
  conversation_id: string;
  from: string;
  message: string;
  created_at: string;
}

// Active DM conversation
export interface DMConversation {
  id: string;
  participant: string;
  unread_count: number;
  last_message_at: string;
}

// Individual DM message
export interface DMMessage {
  id: string;
  from: string;
  content: string;
  created_at: string;
  needs_human_input?: boolean;
}
