import pool from './db/index.js';
import { randomUUID } from 'crypto';

async function seed() {
  const client = await pool.connect();
  try {
    const surveyId = 'test-e2e';

    // Create two sessions (re-sends)
    const session1 = `${surveyId}_session_1`;
    const session2 = `${surveyId}_session_2`;

    await client.query(`
      INSERT INTO survey_sessions (id, survey_id, customer_phone, total_questions, questions_data, status)
      VALUES ($1,$2,$3,5,'[]','completed')
      ON CONFLICT (id) DO NOTHING
    `, [session1, surveyId, '2348163649273']);

    await client.query(`
      INSERT INTO survey_sessions (id, survey_id, customer_phone, total_questions, questions_data, status)
      VALUES ($1,$2,$3,5,'[]','completed')
      ON CONFLICT (id) DO NOTHING
    `, [session2, surveyId, '2348123456789']);

    // Insert a couple of responses referencing those sessions
    const now = new Date();

    await client.query(`
      INSERT INTO survey_responses (id, survey_id, session_id, customer_phone, question_text, question_id, response_text)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO NOTHING
    `, [randomUUID(), surveyId, session1, '2348163649273', 'Q1', 'q1', 'A1']);

    await client.query(`
      INSERT INTO survey_responses (id, survey_id, session_id, customer_phone, question_text, question_id, response_text)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO NOTHING
    `, [randomUUID(), surveyId, session1, '2348163649273', 'Q2', 'q2', 'A2']);

    await client.query(`
      INSERT INTO survey_responses (id, survey_id, session_id, customer_phone, question_text, question_id, response_text)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO NOTHING
    `, [randomUUID(), surveyId, session2, '2348123456789', 'Q1', 'q1', 'A1']);

    console.log('✅ Seeded test sessions and responses');
  } catch (error) {
    console.error('Seed failed', error);
  } finally {
    await client.release();
    await pool.end();
  }
}

seed();
