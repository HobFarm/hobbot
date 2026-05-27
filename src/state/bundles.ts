// SQL layer for Source Bundle Acceptance Contract (migration 0056).
// Single writer for source_bundles + source_bundle_files.
//
// Contract:
//   - ensureSourceBundle is idempotent. Race-safe via INSERT OR IGNORE on the
//     bundle row and per-file rows. Multiple parallel R2 events for the same
//     bundle all converge to the same final state.
//   - attachDocumentToBundle is called once per successfully-ingested file,
//     from the pipeline's chunk stage after documentAdd. Updates BOTH
//     documents and source_bundle_files atomically.
//   - markBundleFileFailed is called from any pre-document failure path
//     (image analysis fail, unsupported MIME, parser truncation, pipeline
//     catch). Failed files stay visible in the bundle catalog.
//   - manifest_file_count is set on first write from the manifest's files[]
//     length; never incremented on document attach (avoids reingest drift).

import type {
  BundleFileRole,
  SourceBundle,
  SourceBundleFile,
  SourceBundleRow,
} from '../grimoire/types'
import { safeJson } from '../grimoire/types'

export interface ManifestFile {
  file_path: string
  r2_key: string
  file_role: BundleFileRole
  file_order: number | null
  file_language: string | null
  notes: string | null
}

export async function ensureSourceBundle(
  db: D1Database,
  args: {
    bundle_id: string
    source_slug: string
    title: string | null
    meta_json: Record<string, unknown>
    files: ManifestFile[]
  }
): Promise<{ created: boolean }> {
  const metaText = JSON.stringify(args.meta_json ?? {})
  const insertRes = await db.prepare(
    `INSERT OR IGNORE INTO source_bundles
       (bundle_id, source_slug, title, meta_json, manifest_file_count)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(args.bundle_id, args.source_slug, args.title, metaText, args.files.length)
    .run()

  const created = (insertRes.meta?.changes ?? 0) > 0

  if (!created) {
    // Refresh title/meta_json/manifest_file_count/updated_at when the row
    // already exists (operator re-uploaded the manifest).
    await db.prepare(
      `UPDATE source_bundles
          SET title = ?,
              meta_json = ?,
              manifest_file_count = ?,
              updated_at = datetime('now')
        WHERE bundle_id = ?`
    )
      .bind(args.title, metaText, args.files.length, args.bundle_id)
      .run()
  }

  if (args.files.length > 0) {
    // Per-file INSERT OR IGNORE — idempotent. Existing rows keep their
    // status/document_id so reingest doesn't clobber prior success state.
    const stmts = args.files.map(f =>
      db.prepare(
        `INSERT OR IGNORE INTO source_bundle_files
           (bundle_id, file_path, r2_key, file_role, file_order, file_language, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        args.bundle_id,
        f.file_path,
        f.r2_key,
        f.file_role,
        f.file_order,
        f.file_language,
        f.notes,
      )
    )
    await db.batch(stmts)
  }

  return { created }
}

export async function markBundleFileProcessing(
  db: D1Database,
  args: { bundle_id: string; file_path: string; ingest_log_id: string }
): Promise<void> {
  await db.prepare(
    `UPDATE source_bundle_files
        SET ingest_log_id = ?,
            status = CASE WHEN status IN ('declared') THEN 'processing' ELSE status END,
            updated_at = datetime('now')
      WHERE bundle_id = ? AND file_path = ?`
  )
    .bind(args.ingest_log_id, args.bundle_id, args.file_path)
    .run()
}

export async function attachDocumentToBundle(
  db: D1Database,
  args: {
    document_id: string
    bundle_id: string
    file_path: string
    bundle_file_role: BundleFileRole
  }
): Promise<void> {
  await db.batch([
    db.prepare(
      `UPDATE documents
          SET source_bundle_id = ?,
              source_bundle_file_path = ?,
              bundle_file_role = ?,
              updated_at = datetime('now')
        WHERE id = ? AND source_bundle_id IS NULL`
    ).bind(args.bundle_id, args.file_path, args.bundle_file_role, args.document_id),
    db.prepare(
      `UPDATE source_bundle_files
          SET document_id = ?,
              status = 'documented',
              error_message = NULL,
              updated_at = datetime('now')
        WHERE bundle_id = ? AND file_path = ?`
    ).bind(args.document_id, args.bundle_id, args.file_path),
  ])
}

export async function markBundleFileFailed(
  db: D1Database,
  args: { bundle_id: string; file_path: string; error_message: string }
): Promise<void> {
  await db.prepare(
    `UPDATE source_bundle_files
        SET status = 'failed',
            error_message = ?,
            updated_at = datetime('now')
      WHERE bundle_id = ? AND file_path = ?`
  )
    .bind(args.error_message.slice(0, 1000), args.bundle_id, args.file_path)
    .run()
}

export async function markBundleFileSkipped(
  db: D1Database,
  args: { bundle_id: string; file_path: string; error_message: string }
): Promise<void> {
  await db.prepare(
    `UPDATE source_bundle_files
        SET status = 'skipped',
            error_message = ?,
            updated_at = datetime('now')
      WHERE bundle_id = ? AND file_path = ?
        AND status IN ('declared','processing')`
  )
    .bind(args.error_message.slice(0, 1000), args.bundle_id, args.file_path)
    .run()
}

export async function getSourceBundle(
  db: D1Database,
  bundle_id: string,
): Promise<SourceBundle | null> {
  const row = await db.prepare(
    'SELECT * FROM source_bundles WHERE bundle_id = ?'
  ).bind(bundle_id).first<SourceBundleRow>()
  if (!row) return null
  return {
    ...row,
    meta_json: safeJson(row.meta_json, {} as Record<string, unknown>),
  }
}

export async function listBundleFiles(
  db: D1Database,
  bundle_id: string,
): Promise<SourceBundleFile[]> {
  const result = await db.prepare(
    `SELECT * FROM source_bundle_files
      WHERE bundle_id = ?
      ORDER BY file_order ASC NULLS LAST, file_path ASC`
  ).bind(bundle_id).all<SourceBundleFile>()
  return result.results ?? []
}
