// Dirty flags for cron phase scheduling.
//
// Each cron phase checks a KV flag before running. If absent AND the phase
// ran within its fallback interval, the phase skips entirely (no D1 SELECT,
// no LLM call). When a write site creates candidates for a phase, it calls
// setDirtyFlags so the next cron tick runs that phase immediately.
//
// Target: ~96% reduction in idle-cycle neuron burn (96 runs/day per phase
// drops to 4-12/day depending on the per-phase fallback interval).
//
// WRITE-SITE → PHASES MAP. Keep this in sync when adding new write paths.
// ---
//   atom INSERT (no category)             → phase_1_classify
//   atom INSERT (with category)           → phase_2_vectorize, phase_3_harmonics, phase_5_register
//   classify queue success (writes cat)   → phase_5_register (cron-only path)
//   chunk INSERT (embedding=pending)      → phase_2b_vectorize_chunks
//   arrangement INSERT/UPDATE             → phase_4_tagging (raises tag_version)
//   recategorize admin (resets embedding) → phase_2_vectorize
//   bulk image candidate approve          → phase_1_classify (or phase_2/3/5 if cat present)
//   knowledge ingest (atoms + chunks)     → phase_1_classify, phase_2b_vectorize_chunks
//   migration atom→chunk                  → phase_2b_vectorize_chunks
// ---
// Phase 8 (connectivity) is NOT in this map. It uses CONNECTIVITY_KV's
// pending event queue as its dirty signal, with an internal 6h sweep
// fallback. See runPhase8Connectivity.

export type CronPhase =
  | 'phase_1_classify'
  | 'phase_2_vectorize'
  | 'phase_2b_vectorize_chunks'
  | 'phase_3_harmonics'
  | 'phase_4_tagging'
  | 'phase_5_register'
  | 'phase_6_correspondences'

export interface DirtyFlag {
  setAt: string
  setBy: string
}

const FLAG_PREFIX = 'dirty:'

/**
 * Set dirty flags for one or more phases. No-op when kv is undefined, so
 * shared code can be called from workers that haven't wired the binding
 * yet (backward-compatible). All puts run in parallel; individual failures
 * are swallowed so the caller's primary write isn't impacted.
 */
export async function setDirtyFlags(
  kv: KVNamespace | undefined,
  phases: CronPhase[],
  setBy: string,
): Promise<void> {
  if (!kv || phases.length === 0) return
  const value = JSON.stringify({ setAt: new Date().toISOString(), setBy } satisfies DirtyFlag)
  await Promise.all(
    phases.map(p => kv.put(`${FLAG_PREFIX}${p}`, value).catch(() => { /* swallow */ }))
  )
}

/**
 * Read a dirty flag without consuming it. Used for inspection.
 */
export async function checkDirtyFlag(
  kv: KVNamespace,
  phase: CronPhase,
): Promise<DirtyFlag | null> {
  const raw = await kv.get(`${FLAG_PREFIX}${phase}`)
  if (!raw) return null
  try { return JSON.parse(raw) as DirtyFlag } catch { return null }
}

/**
 * Read and delete a dirty flag. Cron uses this before running a phase.
 *
 * KV doesn't support atomic read-and-delete. The race window (a flag set
 * between read and delete) results in a redundant cron run on the next
 * tick, which is harmless. Better than the inverse failure mode of
 * silently missing work.
 */
export async function consumeDirtyFlag(
  kv: KVNamespace,
  phase: CronPhase,
): Promise<DirtyFlag | null> {
  const flag = await checkDirtyFlag(kv, phase)
  if (flag) {
    await kv.delete(`${FLAG_PREFIX}${phase}`).catch(() => { /* swallow */ })
  }
  return flag
}

export const ALL_CRON_PHASES: CronPhase[] = [
  'phase_1_classify',
  'phase_2_vectorize',
  'phase_2b_vectorize_chunks',
  'phase_3_harmonics',
  'phase_4_tagging',
  'phase_5_register',
  'phase_6_correspondences',
]
