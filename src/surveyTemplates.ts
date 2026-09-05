// surveyTemplates.ts
// Demo survey templates for WhatsApp simulation

export type SurveyQuestionType = 'button' | 'list' | 'text' | 'multi';

export interface SurveyTemplate {
  id: string;
  name: string;
  questions: Array<{
    id: string;
    text: string;
    options?: string[];
    type: SurveyQuestionType;
    sectionTitle?: string; // for list sections
    placeholder?: string; // for text input
    allowMultiple?: boolean; // for multi-select questions
  }>;
}

export const surveyTemplates: SurveyTemplate[] = [
  {
    id: 'demo_survey_1',
    name: 'Customer Satisfaction Demo Survey',
    questions: [
      {
        id: 'q1',
        text: 'How satisfied are you with our service?',
        options: ['Very satisfied', 'Satisfied', 'Neutral', 'Dissatisfied', 'Very dissatisfied'],
        type: 'list',
        sectionTitle: 'Satisfaction',
      },
      {
        id: 'q2',
        text: 'Would you recommend us to a friend?',
        options: ['Yes', 'No'],
        type: 'button',
      },
      {
        id: 'q3',
        text: 'What did you like most about our service?',
        type: 'text',
        placeholder: 'Type your answer here...',
      },
      {
        id: 'q4',
        text: 'Which of our branches have you visited?',
        options: ['Main Branch', 'Airport Branch', 'Market Branch', 'Online Only'],
        type: 'list',
        sectionTitle: 'Branches',
      },
      {
        id: 'q5',
        text: 'Rate our staff friendliness',
        options: ['Excellent', 'Good', 'Average', 'Poor'],
        type: 'list',
        sectionTitle: 'Staff',
      },
      {
        id: 'q6',
        text: 'Would you like to be contacted for follow-up?',
        options: ['Yes', 'No'],
        type: 'button',
      },
    ],
  },
  {
    id: 'demo_multi_select',
    name: 'Multi-Select Feedback Survey',
    questions: [
      {
        id: 'ms_q1',
        text: 'Which of our services do you use? (Select all that apply)',
        options: ['Mobile Banking', 'Internet Banking', 'ATM Services', 'Branch Banking', 'USSD Banking'],
        type: 'multi',
        sectionTitle: 'Services Used',
        allowMultiple: true,
      },
      {
        id: 'ms_q2',
        text: 'What features matter most to you? (Select all that apply)',
        options: ['Security', 'Speed', 'Customer Support', 'Low Fees', 'User Experience'],
        type: 'multi',
        sectionTitle: 'Features',
        allowMultiple: true,
      },
      {
        id: 'ms_q3',
        text: 'How would you rate your overall experience?',
        options: ['Excellent', 'Good', 'Average', 'Poor'],
        type: 'list',
        sectionTitle: 'Overall',
      },
    ],
  },
];
