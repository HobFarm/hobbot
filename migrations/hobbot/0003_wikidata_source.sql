INSERT INTO sources (id, name, type, endpoint_url, auth_method, sync_cadence, transform_module, target_collection, rate_limit_per_second, batch_size, enabled)
VALUES ('wikidata-visual-arts', 'Wikidata Visual Arts', 'sparql', 'https://query.wikidata.org/sparql', 'none', 'weekly', 'wikidata', 'wikidata', 0.2, 50, 1);
