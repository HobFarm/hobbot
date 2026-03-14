-- Add channel column to blog pipeline tables

ALTER TABLE blog_queue ADD COLUMN channel TEXT DEFAULT 'blog';
ALTER TABLE blog_posts ADD COLUMN channel TEXT DEFAULT 'blog';
