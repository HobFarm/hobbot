SELECT COUNT(*) as total,
       SUM(CASE WHEN relevance_score >= 0.5 AND ingested = 1 THEN 1 ELSE 0 END) as candidates
FROM feed_entries;
