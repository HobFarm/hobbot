// Per-agent daily query budget tracking

import { BUDGET } from '../config'
import type { AgentBudget } from '../grimoire/types'

function todayDate(): string {
  return new Date().toISOString().split('T')[0]
}

export async function getAgentBudget(db: D1Database, agent: string): Promise<AgentBudget> {
  const today = todayDate()

  await db.prepare(
    `INSERT OR IGNORE INTO agent_budgets (agent, queries_today, queries_limit, budget_date)
     VALUES (?, 0, ?, ?)`
  ).bind(agent, BUDGET.QUERIES_PER_DAY, today).run()

  // Reset if stale date
  await db.prepare(
    `UPDATE agent_budgets
     SET queries_today = 0, budget_date = ?, updated_at = datetime('now')
     WHERE agent = ? AND budget_date != ?`
  ).bind(today, agent, today).run()

  const row = await db.prepare(
    'SELECT agent, queries_today, queries_limit, last_query_at, budget_date FROM agent_budgets WHERE agent = ?'
  ).bind(agent).first<AgentBudget>()

  if (!row) throw new Error(`agent_budget_missing: agent=${agent}`)
  return row
}

export async function canQuery(db: D1Database, agent: string): Promise<boolean> {
  const budget = await getAgentBudget(db, agent)
  return budget.queries_today < budget.queries_limit
}

export async function recordQuery(db: D1Database, agent: string): Promise<void> {
  await db.prepare(
    `UPDATE agent_budgets
     SET queries_today = queries_today + 1,
         last_query_at = datetime('now'),
         updated_at = datetime('now')
     WHERE agent = ?`
  ).bind(agent).run()
}

export async function getAllBudgets(db: D1Database): Promise<AgentBudget[]> {
  const result = await db.prepare(
    'SELECT agent, queries_today, queries_limit, last_query_at, budget_date FROM agent_budgets ORDER BY agent'
  ).all<AgentBudget>()
  return result.results ?? []
}
