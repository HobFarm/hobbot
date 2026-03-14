-- Supplemental RSS feed sources: AI research, providers, journalism, visual arts,
-- YouTube awareness, hospitality/live events.
-- All URLs verified 2026-03-10 via scripts/verify-rss-feeds.mjs.
--
-- Dead (excluded): Stability AI (404), Runway (500/404), Black Forest Labs (404),
-- Civitai (404), It's Nice That (404), Restaurant Business Online (invalid XML),
-- Indie Hackers (invalid XML).

-- Core tier (weight 1.5): AI research blogs
INSERT INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, rate_limit_per_second, batch_size, enabled, notes)
VALUES
  ('rss-huggingface', 'Hugging Face Blog', 'rss', 'https://huggingface.co/blog/feed.xml', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"core","weight":1.5,"poll_interval_minutes":360}'),
  ('rss-deepmind', 'DeepMind Blog', 'rss', 'https://deepmind.com/blog/feed/basic/', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"core","weight":1.5,"poll_interval_minutes":360}'),
  ('rss-bair', 'BAIR Berkeley', 'rss', 'https://bair.berkeley.edu/blog/feed.xml', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"core","weight":1.5,"poll_interval_minutes":360}'),
  ('rss-eleutherai', 'EleutherAI', 'rss', 'https://blog.eleuther.ai/index.xml', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"core","weight":1.5,"poll_interval_minutes":360}'),
  ('rss-stanford-crfm', 'Stanford CRFM', 'rss', 'https://crfm.stanford.edu/feed', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"core","weight":1.5,"poll_interval_minutes":360}');

-- Core tier (weight 1.5): AI image/video providers
INSERT INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, rate_limit_per_second, batch_size, enabled, notes)
VALUES
  ('rss-replicate', 'Replicate Blog', 'rss', 'https://replicate.com/blog/rss', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"core","weight":1.5,"poll_interval_minutes":360}'),
  ('rss-nvidia-dev', 'NVIDIA Developer Blog', 'rss', 'https://developer.nvidia.com/blog/feed', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"core","weight":1.5,"poll_interval_minutes":360}'),
  ('rss-fal-ai', 'fal.ai Blog', 'rss', 'https://blog.fal.ai/rss/', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"core","weight":1.5,"poll_interval_minutes":360}'),
  ('rss-comfyui', 'ComfyUI Releases', 'rss', 'https://github.com/comfyanonymous/ComfyUI/releases.atom', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"core","weight":1.5,"poll_interval_minutes":360}');

-- Adjacent tier (weight 1.0): Tech journalism with AI focus
INSERT INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, rate_limit_per_second, batch_size, enabled, notes)
VALUES
  ('rss-wired-ai', 'Wired AI', 'rss', 'https://www.wired.com/feed/tag/ai/latest/rss', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":180}'),
  ('rss-mit-tech-review', 'MIT Technology Review', 'rss', 'https://www.technologyreview.com/feed/', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":180}'),
  ('rss-techcrunch', 'TechCrunch', 'rss', 'https://techcrunch.com/feed/', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":180}'),
  ('rss-404-media', '404 Media', 'rss', 'https://www.404media.co/rss', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":180}'),
  ('rss-venturebeat-ai', 'VentureBeat AI', 'rss', 'https://venturebeat.com/category/ai/feed/', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":180}');

-- Adjacent tier (weight 1.0): Individual researchers/writers
INSERT INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, rate_limit_per_second, batch_size, enabled, notes)
VALUES
  ('rss-simon-willison', 'Simon Willison', 'rss', 'https://simonwillison.net/atom/everything/', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":360}'),
  ('rss-chip-huyen', 'Chip Huyen', 'rss', 'https://huyenchip.com/feed', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":360}'),
  ('rss-latent-space', 'Latent Space', 'rss', 'https://www.latent.space/feed', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":360}'),
  ('rss-one-useful-thing', 'One Useful Thing', 'rss', 'https://www.oneusefulthing.org/feed', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":360}'),
  ('rss-ahead-of-ai', 'Ahead of AI (Raschka)', 'rss', 'https://magazine.sebastianraschka.com/feed', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":360}'),
  ('rss-the-decoder', 'The Decoder', 'rss', 'https://the-decoder.com/feed/', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":360}');

-- Adjacent tier (weight 0.8): arXiv feeds
INSERT INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, rate_limit_per_second, batch_size, enabled, notes)
VALUES
  ('rss-arxiv-cs-cv', 'arXiv cs.CV', 'rss', 'https://arxiv.org/rss/cs.CV', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":0.8,"poll_interval_minutes":720}'),
  ('rss-arxiv-cs-lg', 'arXiv cs.LG', 'rss', 'https://arxiv.org/rss/cs.LG', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":0.8,"poll_interval_minutes":720}');

-- Adjacent tier (weight 1.0): Visual arts, creative tech, photography
INSERT INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, rate_limit_per_second, batch_size, enabled, notes)
VALUES
  ('rss-colossal', 'Colossal', 'rss', 'https://www.thisiscolossal.com/feed/', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":360}'),
  ('rss-creative-bloq', 'Creative Bloq', 'rss', 'https://www.creativebloq.com/feed', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":360}'),
  ('rss-booooooom', 'Booooooom', 'rss', 'https://www.booooooom.com/feed/', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":360}'),
  ('rss-petapixel', 'PetaPixel', 'rss', 'https://petapixel.com/feed', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":360}');

-- Adjacent tier (weight 1.0): YouTube channels (awareness-only, no Grimoire ingest)
INSERT INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, rate_limit_per_second, batch_size, enabled, notes)
VALUES
  ('rss-yt-two-minute-papers', 'Two Minute Papers', 'rss', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCbfYPyITQ-7l4upoX8nvctg', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":720,"ingest_to_grimoire":false}'),
  ('rss-yt-matt-wolfe', 'Matt Wolfe', 'rss', 'https://www.youtube.com/feeds/videos.xml?channel_id=UChpleBmo18P08aKCIgti38g', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":720,"ingest_to_grimoire":false}'),
  ('rss-yt-ai-explained', 'AI Explained', 'rss', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCNJ1Ymd5yFuUPtn21xtRbbw', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"adjacent","weight":1.0,"poll_interval_minutes":720,"ingest_to_grimoire":false}');

-- Long tail (weight 0.5): Hospitality, live events
INSERT INTO sources (id, name, type, endpoint_url, sync_cadence, transform_module, target_collection, rate_limit_per_second, batch_size, enabled, notes)
VALUES
  ('rss-skift', 'Skift', 'rss', 'https://skift.com/feed/', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"long_tail","weight":0.5,"poll_interval_minutes":720}'),
  ('rss-live-design', 'Live Design', 'rss', 'https://www.livedesignonline.com/rss.xml', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"long_tail","weight":0.5,"poll_interval_minutes":720}'),
  ('rss-plsn', 'PLSN', 'rss', 'https://plsn.com/feed/', 'daily', 'rss', 'uncategorized', 1.0, 50, 1,
   '{"tier":"long_tail","weight":0.5,"poll_interval_minutes":720}');
