// services/response.service.ts

import { SaveSurveyResponseParams } from "../flow.types.js";

export async function saveSurveyResponse({
  db,
  session,
  phone,
  responseText,
  responseId
}: SaveSurveyResponseParams) {
  const questionIndex = session.current_question;
  const question = session.questions_data[questionIndex];

  const id = `resp_${Date.now()}`;

  await db.none(
    `INSERT INTO survey_responses (
      id,
      survey_id,
      session_id,
      customer_phone,
      question_text,
      question_id,
      response_text,
      response_id,
      created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      session.survey_id,
      session.id,
      phone,
      question.question,
      `${session.id}_q${questionIndex + 1}`,
      responseText,
      responseId,
      new Date().toISOString()
    ]
  );
}

export async function getSurveyResponsesBySession(db: any, sessionId: string) {
  const result = await db.query(
    `SELECT question_id, question_text, response_text, response_id, created_at
     FROM survey_responses
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );

  return Array.isArray(result?.rows) ? result.rows : [];
}
