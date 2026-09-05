// handlers/survey.handler.ts

import { Pool } from "pg";
import { saveSurveyResponse } from "../services/response.service.js";
import { completeSession, updateSessionProgress, updateSessionMultiSelections } from "../services/session.service.js";
import { getSurveyResponsesBySession } from "../services/response.service.js";

const multiSelectionCache = new Map<string, Record<number, string[]>>();

type HandleSurveyMessageParams = {
  db: Pool;
  message: any;
  session: any;
  phone: string;
  contactName?: string | null;
  sendMessage: (to: string, msg: string) => Promise<void>;
  sendQuestion: (to: string, question: any, session: any) => Promise<void>;
};

function findNextVisibleQuestion(questions: any[], fromIndex: number, answers: Record<string, string>): number {
  for (let i = fromIndex; i < questions.length; i++) {
    const q = questions[i];
    if (!q.showIf) return i;
    const depAnswer = String(answers[q.showIf.dependsOn] ?? '').toLowerCase().trim();
    const expected = String(q.showIf.equals ?? '').toLowerCase().trim();
    if (depAnswer === expected) return i;
  }
  return questions.length;
}

async function buildAnswersMap(
  db: Pool,
  sessionId: string,
  questions: any[],
  currentIndex: number,
  currentAnswer: string,
): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  try {
    const saved = await getSurveyResponsesBySession(db, sessionId);
    for (const resp of saved) {
      const match = String(resp.question_id || '').match(/_q(\d+)$/);
      if (match) {
        const qIdx = parseInt(match[1], 10) - 1;
        const q = questions[qIdx];
        if (q?.id) answers[q.id] = resp.response_text;
      }
    }
  } catch {
    // ignore
  }

  const currentQ = questions[currentIndex];
  if (currentQ?.id) answers[currentQ.id] = currentAnswer;
  return answers;
}

export async function handleSurveyMessage({
  db,
  message,
  session,
  phone,
  contactName,
  sendMessage,
  sendQuestion,
}: HandleSurveyMessageParams) {
  void contactName;

  // Expiry check
  if (session.expires_at) {
    const expiresAt = new Date(session.expires_at);
    if (Date.now() > expiresAt.getTime()) {
      try {
        await db.query(`UPDATE survey_sessions SET status = 'expired', updated_at = NOW() WHERE id = $1`, [session.id]);
      } catch {
        // ignore
      }
      await sendMessage(phone, 'This survey has ended.');
      return;
    }
  }

  const normalizeForMatch = (s: any) => {
    try {
      return String(s || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    } catch {
      return String(s || '').toLowerCase().trim();
    }
  };

  const buttonReply = message?.interactive?.button_reply;
  const listReply = message?.interactive?.list_reply;
  const textBody = typeof message?.text?.body === 'string' ? message.text.body : '';
  const rawAnswer = buttonReply?.title || listReply?.title || buttonReply?.id || listReply?.id || textBody;

  if (!rawAnswer) return;

  const questions: any[] = (() => {
    try {
      if (typeof session.questions_data === 'string') return JSON.parse(session.questions_data);
      return Array.isArray(session.questions_data) ? session.questions_data : [];
    } catch {
      return [];
    }
  })();

  if (normalizeForMatch(rawAnswer) === 'exit') {
    await completeSession(db, session.id);
    await sendMessage(phone, 'You have exited the survey. Thank you! 👋');
    return;
  }

  const currentIndex = typeof session.current_question === 'number' && session.current_question >= 0 ? session.current_question : 0;

  // Intro proceed flow
  if (session.current_question === -1) {
    const isProceed = (buttonReply?.id || listReply?.id || '').includes('survey_intro_proceed') || normalizeForMatch(rawAnswer) === 'proceed';
    if (!isProceed) {
      await sendMessage(phone, 'Click *Proceed* to start the survey, or type *EXIT* to stop.');
      return;
    }

    const firstIdx = findNextVisibleQuestion(questions, 0, {});
    if (firstIdx >= questions.length) {
      await completeSession(db, session.id);
      await sendMessage(phone, 'Thanks! Survey completed. ✅');
      return;
    }

    await updateSessionProgress(db, session.id, firstIdx);
    session.current_question = firstIdx;
    return sendQuestion(phone, questions[firstIdx], session);
  }

  if (currentIndex >= questions.length) {
    await completeSession(db, session.id);
    await sendMessage(phone, 'Thanks! Survey completed. ✅');
    return;
  }

  const currentQuestion = questions[currentIndex];
  const isMultiSelect = currentQuestion?.type === 'multi' || currentQuestion?.allowMultiple === true;

  if (isMultiSelect) {
    const replyId: string = buttonReply?.id || listReply?.id || '';
    const isDoneReply = replyId.includes('_done') || normalizeForMatch(rawAnswer) === 'done';

    let multiSelections: string[] = [];
    try {
      const raw = session.questions_data?.[currentIndex]?.multiSelections;
      if (Array.isArray(raw)) multiSelections = raw;
    } catch {
      // ignore
    }

    const cacheKey = session.id;
    const cachedForSession = multiSelectionCache.get(cacheKey) || {};
    const cachedSelections = cachedForSession[currentIndex];
    if (Array.isArray(cachedSelections) && cachedSelections.length > 0 && multiSelections.length === 0) {
      multiSelections = [...cachedSelections];
    }

    const opts: string[] = Array.isArray(currentQuestion.options) ? currentQuestion.options : [];

    if (isDoneReply) {
      if (multiSelections.length === 0) {
        await sendMessage(phone, 'Please select at least one option before tapping Done ✅.');
        return sendQuestion(phone, { ...currentQuestion, multiSelections }, session);
      }

      const responseText = multiSelections.join(', ');
      await saveSurveyResponse({
        db,
        session,
        phone,
        responseText,
        responseId: `${session.id}_q${currentIndex + 1}_multi`,
      });

      await updateSessionMultiSelections(db, session.id, currentIndex, []);

      const nextCache = { ...(multiSelectionCache.get(cacheKey) || {}) };
      delete nextCache[currentIndex];
      if (Object.keys(nextCache).length === 0) multiSelectionCache.delete(cacheKey);
      else multiSelectionCache.set(cacheKey, nextCache);

      const answers = await buildAnswersMap(db, session.id, questions, currentIndex, responseText);
      const nextIndex = findNextVisibleQuestion(questions, currentIndex + 1, answers);

      if (nextIndex >= questions.length) {
        await completeSession(db, session.id);
        const responses = await getSurveyResponsesBySession(db, session.id);
        const recapLines = responses.length > 0
          ? responses.map((r, i) => `*${r.question_text || `Question ${i + 1}`}*\n${r.response_text || 'No response'}`).join('\n\n')
          : 'No responses recorded.';
        await sendMessage(phone, `Thanks! Survey completed.\n\nThis is what we received:\n\n${recapLines}`);
        return;
      }

      await updateSessionProgress(db, session.id, nextIndex);
      session.current_question = nextIndex;
      return sendQuestion(phone, questions[nextIndex], session);
    }

    let selectedOpt: string | null = null;

    if (replyId && replyId.includes(`_q${currentIndex + 1}_multi_opt`)) {
      const m = replyId.match(/_opt(\d+)$/);
      if (m) {
        const idx = parseInt(m[1], 10) - 1;
        if (opts[idx]) selectedOpt = opts[idx];
      }
    } else {
      const norm = normalizeForMatch(rawAnswer);
      const normalizedOpts = opts.map((o) => normalizeForMatch(o));
      const matchIdx = normalizedOpts.indexOf(norm);
      if (matchIdx >= 0) selectedOpt = opts[matchIdx];
    }

    if (!selectedOpt) {
      await sendMessage(phone, 'Please select from the available options, or tap *Done ✅* when finished.');
      return sendQuestion(phone, { ...currentQuestion, multiSelections }, session);
    }

    if (multiSelections.includes(selectedOpt)) {
      multiSelections = multiSelections.filter((s) => s !== selectedOpt);
    } else {
      multiSelections = [...multiSelections, selectedOpt];
    }

    await updateSessionMultiSelections(db, session.id, currentIndex, multiSelections);
    session.questions_data[currentIndex] = { ...currentQuestion, multiSelections };
    multiSelectionCache.set(cacheKey, {
      ...(multiSelectionCache.get(cacheKey) || {}),
      [currentIndex]: [...multiSelections],
    });

    return sendQuestion(phone, { ...currentQuestion, multiSelections }, session);
  }

  // Standard single-select / text
  let responseTextToSave = rawAnswer;
  let responseIdToSave = message.id;

  const isInteractiveQuestion = currentQuestion?.type === 'button' || currentQuestion?.type === 'list' || (currentQuestion?.options?.length && !currentQuestion?.type);
  if (isInteractiveQuestion && currentQuestion.options?.length) {
    const normalizedOptions = currentQuestion.options.map((opt: string) => normalizeForMatch(opt));
    const replyId = buttonReply?.id || listReply?.id;

    if (replyId && typeof replyId === 'string' && replyId.includes(session.id)) {
      const m = replyId.match(/_opt(\d+)$/);
      if (m) {
        const idx = parseInt(m[1], 10) - 1;
        if (currentQuestion.options[idx]) {
          responseTextToSave = currentQuestion.options[idx];
          responseIdToSave = replyId;
        }
      }
    } else {
      const normalizedAnswer = normalizeForMatch(rawAnswer || '');
      if (!normalizedOptions.includes(normalizedAnswer)) {
        await sendMessage(phone, 'Please select from the available options below');
        return sendQuestion(phone, currentQuestion, session);
      }
      const matchedIndex = normalizedOptions.indexOf(normalizedAnswer);
      if (matchedIndex >= 0) responseTextToSave = currentQuestion.options[matchedIndex];
    }
  }

  await saveSurveyResponse({
    db,
    session,
    phone,
    responseText: responseTextToSave,
    responseId: responseIdToSave,
  });

  const answers = await buildAnswersMap(db, session.id, questions, currentIndex, responseTextToSave);
  const nextIndex = findNextVisibleQuestion(questions, currentIndex + 1, answers);

  if (nextIndex >= questions.length) {
    await completeSession(db, session.id);
    const responses = await getSurveyResponsesBySession(db, session.id);
    const recapLines = responses.length > 0
      ? responses.map((r, i) => `*${r.question_text || `Question ${i + 1}`}*\n${r.response_text || 'No response'}`).join('\n\n')
      : 'No responses recorded.';
    await sendMessage(phone, `Thanks! Survey completed.\n\nThis is what we received:\n\n${recapLines}`);
    return;
  }

  await updateSessionProgress(db, session.id, nextIndex);
  session.current_question = nextIndex;
  return sendQuestion(phone, questions[nextIndex], session);
}
