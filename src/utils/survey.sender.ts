import { SendSurveyQuestionParams } from "../flow.types.js"
import { sendWhatsAppList, sendWhatsAppMessage, sendWhatsAppSurvey, sendWhatsAppTemplate, sendWhatsAppTyping } from "../whatsapp-client.js"
import { setLastOutbound } from './outboundTracker.js'

export async function sendSurveyIntro({
  to,
  phoneNumberId,
  surveyIntroTemplateId,
}: {
  to: string;
  phoneNumberId?: string;
  surveyIntroTemplateId?: string;
}) {
  // This rich fallback card is shown when no template is configured or the template send fails
 
  // const introText = `*Dear Valued Firstbanker,*\n\nWelcome to the *FBNBank Customer Survey*.\n\nPlease help us fill out this quick survey. Your feedback is incredibly important to us and helps us improve our services for you! 🌟\n\n⏱️ *Time:* Less than 2 minutes\n🛑 _Type *EXIT* at any time to stop._`;
  const introText = `👤 *Dear Valued Firstbanker*\n\nPlease help us fill out this quick survey. Your feedback is incredibly important to us and helps us improve our services for you! 🌟\n\n⏱️ *Time:* Less than 2 minutes\n🛑 _Type *EXIT* at any time to stop._`;

  // Track intro as survey outbound so a typed "proceed" is routed to survey handler.
  setLastOutbound(to, 'survey_question');

  const proactiveTemplate = surveyIntroTemplateId;

  if (proactiveTemplate) {
    console.log('Attempting proactive template for survey intro:', proactiveTemplate);
    try {
      const templateSent = await sendWhatsAppTemplate({
        to,
        templateId: proactiveTemplate,
        phoneNumberId,
        templateData: {},
      });
      if (templateSent) {
        console.log('✅ Survey intro template sent. Sending Proceed button...');
        // Template is text-only — send the interactive Proceed button as a follow-up
        return sendWhatsAppSurvey({
          to,
          question: "Click the button below to start the survey, or type 'end' to stop.",
          options: [{ id: 'survey_intro_proceed', title: 'Proceed' }],
          headerText: '',
          footerText: '',
          phoneNumberId,
        });
      }
    } catch (err) {
      console.warn('Proactive intro template threw an error; falling back to interactive card.', err);
    }
    console.warn('Proactive intro template send failed; falling back to interactive intro card.');
  }

  // Fallback: rich interactive card with Proceed button (matches image 3)
  return sendWhatsAppSurvey({
    to,
    question: introText,
    options: [{ id: 'survey_intro_proceed', title: 'Proceed' }],
    headerText: 'Firstbank Survey',
    footerText: 'Click the button below to proceed',
    phoneNumberId,
  });
}



export async function sendSurveyQuestion({
  to,
  session,
  question,
  phoneNumberId,
}: SendSurveyQuestionParams) {

  if (!session) {
    console.error("❌ Missing session in sendSurveyQuestion")
    return false
  }

  const index = session.current_question;
  const total = session.total_questions;
        
  const footerText = `Question ${index + 1} of ${total}`;

  let qText = question.text ?? question.question;
  if (!qText) return false;

  const headerText = index === 0 ? "" : undefined;

  const opts = question.options ?? [];
  const hasOptions = Array.isArray(opts) && opts.length > 0;

  // ─── MULTI-SELECT (allowMultiple) ─────────────────────────────────────────
  if (hasOptions && (question.type === 'multi' || question.allowMultiple)) {
    const selected = question.multiSelections ?? [];
    const pendingSelected = selected.filter(s => opts.includes(s));

    // Build the question text showing current selections
    let displayText = qText;
    if (pendingSelected.length > 0) {
      displayText += `\n\n✅ *Selected:* ${pendingSelected.join(', ')}`;
    }
    displayText += `\n\n*Tap each option to toggle it on/off.*\nWhen done, tap _Done ✅_ to continue.`;

    // Build buttons: each option + Done
    const buttons = opts.map((opt, i) => ({
      id: `${session.id}_q${index + 1}_multi_opt${i + 1}`,
      title: opt.length > 20 ? opt.substring(0, 17) + '...' : opt,
    }));

    // WhatsApp only allows up to 3 buttons. If more than 2 options (+ Done = 3), use list instead.
    if (opts.length <= 2) {
      // Use buttons: toggles + Done
      const allButtons = [
        ...buttons,
        { id: `${session.id}_q${index + 1}_done`, title: 'Done ✅' },
      ];
      setLastOutbound(to, 'survey_question');
      return sendWhatsAppSurvey({
        to,
        question: displayText,
        options: allButtons,
        headerText,
        footerText,
        phoneNumberId,
      });
    } else {
      // Use list for many options: each option as a row + a "Done" row
      setLastOutbound(to, 'survey_question');
      return sendWhatsAppList({
        to,
        headerText,
        bodyText: displayText,
        footerText,
        buttonText: 'Select',
        phoneNumberId,
        sections: [
          {
            title: question.sectionTitle || 'Options',
            rows: [
              ...opts.map((opt, i) => ({
                id: `${session.id}_q${index + 1}_multi_opt${i + 1}`,
                title: opt.length > 24 ? opt.substring(0, 21) + '...' : opt,
              })),
              { id: `${session.id}_q${index + 1}_done`, title: 'Done ✅' },
            ],
          },
        ],
      });
    }
  }

  // ─── BUTTON / LIST / TEXT (existing logic) ────────────────────────────────
  if (hasOptions) {
    const useButtons = question.type === 'button' || (question.type === undefined && opts.length <= 2);
    const useList = question.type === 'list' || (question.type === undefined && opts.length > 2);

    // Mark outbound
    setLastOutbound(to, 'survey_question');

    if (useButtons) {
      return sendWhatsAppSurvey({
        to,
        question: qText,
        options: opts.map((opt, i) => ({ id: `${session.id}_q${index + 1}_opt${i + 1}`, title: opt })),
        headerText,
        footerText,
        phoneNumberId,
      });
    }

    if (useList) {
      return sendWhatsAppList({
        to,
        headerText,
        bodyText: qText, 
        footerText,
        buttonText: 'Select',
        phoneNumberId,
        sections: [
          {
            title: question.sectionTitle || 'Options',
            rows: opts.map((opt, i) => ({ id: `${session.id}_q${index + 1}_opt${i + 1}`, title: opt })),
          },
        ],
      });
    }
  }

  // TEXT FALLBACK (FIXED)
  setLastOutbound(to, 'survey_question');
  
  return sendWhatsAppMessage({
    to,
    message: `${qText}\n\n${footerText}\n(Reply with your answer)`,
    phoneNumberId,
  });
}
