// services/session.service.ts
import type { Pool } from 'pg';

export async function getActiveSurveySession(db: Pool, phone: string) {
  // Auto-expire sessions whose expires_at has passed (non-fatal if column not yet added)
  await db.query(
    `UPDATE survey_sessions
     SET status = 'expired', updated_at = NOW()
     WHERE customer_phone = $1
       AND status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at < NOW()`,
    [phone]
  ).catch(() => {});

  const result = await db.query(
    `SELECT * FROM survey_sessions
     WHERE customer_phone = $1
     AND status = 'active'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [phone]
  );

  console.log(`\n\nChecked active session. Found: ${result.rows.length > 0}`);
  return result.rows[0];
}

export async function updateSessionProgress(db: Pool, sessionId: string, nextIndex: number) {
  const result = await db.query(
    `UPDATE survey_sessions
     SET current_question = $1, updated_at = NOW()
     WHERE id = $2`,
    [nextIndex, sessionId]
  );
  console.log(`\n\nSession ${sessionId} moved to question index ${nextIndex}.`);
  return result;
}

/** Persists multi-select toggle state into questions_data JSONB for a specific question index. */
export async function updateSessionMultiSelections(db: Pool, sessionId: string, questionIndex: number, selections: string[]) {
  // Use jsonb_set to update the multiSelections array for the question at questionIndex
  await db.query(
    `UPDATE survey_sessions
     SET questions_data = jsonb_set(
       questions_data,
       ('{' || $1::text || ',multiSelections}')::text[],
       $2::jsonb,
       true
     ),
     updated_at = NOW()
     WHERE id = $3`,
    [questionIndex, JSON.stringify(selections), sessionId]
  );
}

export async function completeSession(db: Pool, sessionId: string) {
  const result = await db.query(
    `UPDATE survey_sessions
     SET status = 'completed', updated_at = NOW()
     WHERE id = $1`,
    [sessionId]
  );
  console.log(`\n\nSession ${sessionId} marked as completed.`);
  try {
    await db.query(
      `UPDATE survey_sessions
       SET status = 'completed', updated_at = NOW()
       WHERE customer_phone = (
         SELECT customer_phone FROM survey_sessions WHERE id = $1
       )
       AND status = 'active'
       AND id <> $1`,
      [sessionId]
    );
    console.log(`\n\nOther active sessions for session ${sessionId} customer marked completed.`);
  } catch (e) {
    console.warn('Failed to cleanup other active sessions for', sessionId, e);
  }
  return result;
}
