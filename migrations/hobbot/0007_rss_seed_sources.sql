-- Seed RSS feed sources into the source registry.
-- Tier/weight/poll_interval stored in notes JSON (avoids schema change to sources table).
-- All URLs verified 2026-03-10. Runway and Stability AI feeds are 404, excluded.

-- Core tier (weight 1.5): AI tools and research
INSERT INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, rate_limit_per_second, batch_size, enabled, notes)
VALUES
  ('rss-openai', 'OpenAI Blog', 'rss', 'https://openai.com/blog/rss.xml', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"core","weight":1.5,"poll_interval_minutes":360}'),
  ('rss-google-ai', 'Google AI Blog', 'rss', 'https://blog.google/technology/ai/rss/', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"core","weight":1.5,"poll_interval_minutes":360}');

-- Adjacent tier (weight 1.0): tech + culture
INSERT INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, rate_limit_per_second, batch_size, enabled, notes)
VALUES
  ('rss-hn', 'Hacker News (100+ points)', 'rss', 'https://hnrss.org/newest?points=100', 'hourly', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":60}'),
  ('rss-verge-ai', 'The Verge AI', 'rss', 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":180}'),
  ('rss-arstechnica', 'Ars Technica', 'rss', 'https://arstechnica.com/feed/', 'daily', 'rss', 'uncategorized', 0.8, 50, 1,
   '{"tier":"adjacent","weight":0.8,"poll_interval_minutes":360}');

-- Sync run tracking: register the virtual source for sync_runs FK
INSERT INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, rate_limit_per_second, batch_size, enabled, notes)
VALUES
  ('rss-feeds', 'RSS Feed Aggregator', 'rss', NULL, 'hourly', 'rss', 'uncategorized', 1.0, 50, 0,
   '{"tier":"system","weight":0,"poll_interval_minutes":0}');
