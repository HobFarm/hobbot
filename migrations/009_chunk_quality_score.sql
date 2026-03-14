-- Add quality_score column to document_chunks for inline enrichment pipeline
ALTER TABLE document_chunks ADD COLUMN quality_score REAL;
