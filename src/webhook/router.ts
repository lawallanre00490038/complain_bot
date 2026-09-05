// webhook/router.ts
import { Pool } from 'pg';
import { handleChatMessage } from "../handlers/chat.handler.js";
import { handleSurveyMessage } from "../handlers/survey.handler.js";
import escalationService from '../services/escalation-service.js';
import chatHistoryService from '../services/chat-history-service.js';
import { getActiveSurveySession } from "../services/session.service.js";
import { decryptWhatsAppFlowData } from '../utils/encryption.helper.js';

import { Mastra } from '@mastra/core';
import { normalizePhone } from '../utils/format_phone.js';
import { sendSurveyQuestion } from '../utils/survey.sender.js';
import * as metaSurveyService from '../meta-flow/meta-survey.service.js';

// Simple in-memory name store for fallback when webhook doesn't provide contact name.
// NOTE: This is process-local. For production persist to DB or agent memory store.
const nameStore: Map<string, string> = new Map();
const namePending: Set<string> = new Set();

type RouteIncomingMessageParams = {
  db: Pool;
  mastra: Mastra;
  message: any;

  phone: string;
  contactName?: string | null;
  messageId: string;
  phoneNumberId?: string;

  // process-lifetime map of last outbound message type per phone
  lastOutboundType?: Map<string, string>;

  sendMessage: (to: string, msg: string) => Promise<void>;

  sendQuestion: (
    to: string,
    question: any,
    session?: any
  ) => Promise<void>;
};


export async function routeIncomingMessage({
  db,
  mastra,
  message,
  phone,
  contactName,
  messageId,
  phoneNumberId,
  lastOutboundType,
  sendMessage,
  sendQuestion,
}: RouteIncomingMessageParams) {

  console.log('Checking session for:', phone);
  const normalizedPhone = normalizePhone(phone);
  const activeEscalation = await escalationService.getLatestHumanOwnedEscalationByPhone(db, normalizedPhone);
  const latestEscalation = activeEscalation ?? await escalationService.getLatestActiveEscalationByPhone(db, normalizedPhone);

  const inboundText =
    (typeof message?.text?.body === 'string' && message.text.body.trim()) ||
    message?.interactive?.button_reply?.title ||
    message?.interactive?.list_reply?.title ||
    `[non-text message: ${message?.type || 'unknown'}]`;

  try {
    await chatHistoryService.logChatMessage({
      db,
      threadId: normalizedPhone,
      role: 'Customer',
      messageText: inboundText,
      escalationId: latestEscalation?.ticket_id || null,
      sourceMessageId: messageId,
      metadata: {
        messageType: message?.type || 'unknown',
      },
    });
  } catch (error) {
    console.error('Failed to log inbound customer chat message', error);
  }

  if (activeEscalation) {
    try {
      await escalationService.logEscalationMessage({
        db,
        ticketId: activeEscalation.ticket_id,
        direction: 'inbound',
        messageText: inboundText,
        customerPhone: normalizedPhone,
        sourceMessageId: messageId,
      });
    } catch (error) {
      console.error('Failed to log inbound escalation message', error);
    }

    console.log('Human handoff is active for', normalizedPhone, '- suppressing automated reply while a human agent owns the conversation.');
    return;
  }

  // ── Meta Flow nfm_reply: user completed a WhatsApp Flow survey ───────────
  if (message?.type === 'interactive' && message?.interactive?.type === 'nfm_reply') {
    try {
      const nfmReply = message.interactive.nfm_reply;
      let responseJson = nfmReply?.response_json;

      // 2. CHECK FOR ENCRYPTION
      if (nfmReply?.encrypted_flow_data) {
        console.log('[router] Detected encrypted Flow data. Decrypting...');
        try {
            responseJson = decryptWhatsAppFlowData(
              nfmReply.encrypted_flow_data,
              nfmReply.encrypted_aes_key,
              nfmReply.initial_vector
            );
        } catch (decryptErr) {
            console.error('[router] Decryption failed!', decryptErr);
            return; // Stop if we can't read the data
        }
      }

      if (responseJson) {
        const parsed: Record<string, any> = typeof responseJson === 'string'
          ? JSON.parse(responseJson)
          : responseJson;

        const flowToken = parsed?.flow_token;
        const payloadFlowId = parsed?.flow_id;

        if (flowToken) {
          const { flow_token, flow_id, ...responseFields } = parsed;
          let resolvedFlowId = payloadFlowId ? String(payloadFlowId) : 'unknown';
          let surveyId: string | undefined;

          if (resolvedFlowId === 'unknown') {
            try {
              const tokenMap = await metaSurveyService.getMetaFlowTokenMapByToken(db, String(flowToken));
              if (tokenMap?.flow_id) {
                resolvedFlowId = tokenMap.flow_id;
              }
              surveyId = tokenMap?.survey_id || undefined;
            } catch {
              // non-fatal lookup failure
            }
          }

          if (!surveyId && resolvedFlowId !== 'unknown') {
            try {
              const localFlow = await metaSurveyService.getMetaFlowSurveyByFlowId(db, resolvedFlowId);
              surveyId = localFlow?.survey_id || undefined;
            } catch {
              // non-fatal lookup failure
            }
          }

          await metaSurveyService.saveMetaFlowResponse(db, {
            flowId: resolvedFlowId,
            flowToken,
            customerPhone: normalizedPhone,
            surveyId,
            responses: responseFields,
            source: 'nfm_reply',
          });
          console.log('[router] nfm_reply saved (decrypted): flow=%s phone=%s', resolvedFlowId, normalizedPhone);
        }
      }
    } catch (err) {
      console.error('[router] Failed to handle nfm_reply response', err);
    }
    return;
  }

  // Prefer any previously-stored name (fallback persistence)
  if (!contactName && nameStore.has(String(phone))) {
    contactName = nameStore.get(String(phone)) as string;
  }

  // If we don't have a name yet, ask for it once and mark pending
  const textBody = typeof message?.text?.body === 'string' ? message.text.body.trim() : '';
  if (!contactName) {
    // If we already asked for the name and the current message is their reply, save it
    if (namePending.has(String(phone)) && textBody) {
      const proposedName = textBody.split('\n')[0].trim().slice(0, 64);
      nameStore.set(String(phone), proposedName);
      namePending.delete(String(phone));
      console.log('Saved fallback name for', phone, '=>', proposedName);
      // Acknowledge and continue to process next incoming message (do not treat this as a chat message)
      await sendMessage(phone, `Thanks ${proposedName}! How can I help you today?`);
      return;
    }

    // Otherwise, ask for the name and stop processing this event
    if (!namePending.has(String(phone))) {
      namePending.add(String(phone));
      await sendMessage(phone, "👋 Hi! May I have your name so I can address you properly?");
    }
    return;
  }
  const session = await getActiveSurveySession(db, normalizedPhone);

  // Decide whether this incoming message should be handled by the survey flow.
  // Route to survey handler when:
  // - the message is an interactive reply (button/list), OR
  // - the last outbound to the phone was a survey question, OR
  // - the user sent an explicit exit command while a session exists.
  let lastOutbound: string | undefined;
  try {
    lastOutbound = lastOutboundType?.get(String(phone)) ?? undefined;
  } catch (e) {
    // ignore
  }

  const interactiveReply = !!(message?.interactive?.button_reply || message?.interactive?.list_reply);
  const isExitCmd = ['exit', 'quit', 'stop', 'end'].includes((textBody || '').toLowerCase());

  // Determine the type of the current question (if any). If the current
  // question is a free-text/input question (not 'button'/'list') then we
  // should route incoming plain-text replies to the survey handler even when
  // they are not interactive replies.
  let currentQuestionType: string | undefined;
  try {
    const currentIndex = session?.current_question;
    const questions = session?.questions_data;
    const currentQuestion = Array.isArray(questions) && typeof currentIndex === 'number'
      ? questions[currentIndex]
      : undefined;
    // If the question object doesn't include an explicit `type`, infer it
    // from the presence of `options` (treat as interactive list/button).
    currentQuestionType = currentQuestion?.type ?? (currentQuestion?.options?.length ? 'list' : undefined);
  } catch (e) {
    // ignore parsing errors
  }

  // If the current question is interactive (button/list) but the user typed
  // a plain text reply, we still want the survey handler to validate it and
  // re-send the question when invalid instead of falling through to chat.
  const typedTextForInteractiveQuestion = !!(textBody && (currentQuestionType === 'button' || currentQuestionType === 'list'));
  console.log('currentQuestionType=', currentQuestionType, 'typedTextForInteractiveQuestion=', typedTextForInteractiveQuestion);

  if (
    session && (
      interactiveReply ||
      lastOutbound === 'survey_question' ||
      isExitCmd ||
      // route plain-text when the current question expects free-text
      (currentQuestionType && currentQuestionType !== 'button' && currentQuestionType !== 'list') ||
      // or when the user typed text while an interactive question is active
      typedTextForInteractiveQuestion
    )
  ) {
    console.log('Survey session found for', phone, 'Routing to survey handler.');
    return handleSurveyMessage({
      db,
      message,
      session,
      phone,
      sendMessage,
      contactName,
      sendQuestion: async (to, question, session) => {
        console.log('Calling sendSurveyQuestion for', to, question);
        await sendSurveyQuestion({
          to,
          session,
          question,
        })
      },
    });
  }

  if (message.text || message.type === 'location') {
    console.log('No survey session for', phone, 'Routing to chat handler.');

    const chatText = message.type === 'location' 
      ? `[User shared their location: Latitude ${message.location?.latitude}, Longitude ${message.location?.longitude}]`
      : message.text?.body;

    return handleChatMessage({
      mastra,
      phone,
      text: chatText,
      contactName,
      messageId,
      phoneNumberId,
      sendMessage,
      onAiReply: async (to: string, reply: string) => {
        await chatHistoryService.logChatMessage({
          db,
          threadId: normalizePhone(String(to)),
          role: 'AI',
          messageText: reply,
          escalationId: latestEscalation?.ticket_id || null,
        });
      },
    });
  }

  // Handle interactive list_reply taps from the capabilities menu
  // (only when there is no active survey session — survey list_reply is handled above)
  if (message.interactive?.list_reply) {
    const { title } = message.interactive.list_reply as { id: string; title: string };
    console.log('No survey session for', phone, '— routing list_reply to chat handler. title:', title);
    return handleChatMessage({
      mastra,
      phone,
      text: title,
      contactName,
      messageId,
      phoneNumberId,
      sendMessage,
      onAiReply: async (to: string, reply: string) => {
        await chatHistoryService.logChatMessage({
          db,
          threadId: normalizePhone(String(to)),
          role: 'AI',
          messageText: reply,
          escalationId: latestEscalation?.ticket_id || null,
        });
      },
    });
  }
}
