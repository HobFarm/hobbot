// Lightweight in-memory cycle event collector
// Accumulates events during the hot processing loop without D1 writes.
// Handed off to the reflect phase at cycle end.

import type { CycleEvents, NotableInteraction } from './types';

/**
 * Create a fresh cycle collector. Call once at the start of each cron cycle.
 */
export function createCycleCollector(): CycleEvents {
  return {
    postsDiscovered: 0,
    postsEngaged: 0,
    attacksCataloged: 0,
    postsFailed: 0,
    repliesSent: 0,
    notableInteractions: [],
  };
}

/**
 * Record a notable interaction during the cycle.
 * Cap at 20 interactions to bound memory usage.
 */
export function recordNotableInteraction(
  collector: CycleEvents,
  interaction: NotableInteraction
): void {
  if (collector.notableInteractions.length < 20) {
    collector.notableInteractions.push(interaction);
  }
}

/**
 * Return a snapshot of the cycle events. Safe to call multiple times.
 */
export function getCycleEvents(collector: CycleEvents): CycleEvents {
  return { ...collector, notableInteractions: [...collector.notableInteractions] };
}
