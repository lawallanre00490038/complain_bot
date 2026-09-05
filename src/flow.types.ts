export interface SendSurveyParams {
  to: string;
  surveyId?: string;
  question: string;
  options: {
    id: string;
    title: string;
  }[];
  headerText?: string;
  footerText?: string;
}

export interface SaveSurveyResponseParams {
    db: any; // Replace with your actual DB type
    session: {
      id: string;
      current_question: number;
      total_questions: number;
      survey_id: string;
      questions_data: Array<{
        question: string;
        allowMultiple?: boolean;
        multiSelections?: string[];
      }>;
    };
    phone: string;
    responseText: string;
    responseId: string;
  }


export interface SurveyQuestion {
  type?: 'button' | 'list' | 'text' | 'multi';
  text?: string;
  question: string;
  options?: string[];
  sectionTitle?: string;
  placeholder?: string;
  /** If true, user can select multiple options (multi-select / checkbox style) */
  allowMultiple?: boolean;
  /** Accumulated selections for multi-select questions (stored in session) */
  multiSelections?: string[];
}


type SurveySession = {
  id: string;
  current_question: number;
  total_questions: number;
};

export interface SendSurveyQuestionParams {
  to: string;
  session: SurveySession;
  question: SurveyQuestion;
  phoneNumberId?: string;
}
