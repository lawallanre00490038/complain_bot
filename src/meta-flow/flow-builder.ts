/**
 * WhatsApp Flow JSON Builder for Survey Flows
 *
 * All questions live on ONE screen (QUESTIONS).
 * Independent questions are always visible.
 * Conditional questions (showIf) start hidden and pop into view when the user
 * picks the triggering option on the parent question.
 *
 * How it works:
 *  - Screen declares `data` variables: show_<id>: boolean (false by default)
 *  - Conditional components use `visible: "${data.show_<id>}"`
 *  - Parent questions (list/button) carry `on-select-action: data_exchange`
 *    so each selection hit the server, which responds with updated `data` flags
 *  - Footer "Submit" sends all field values + `__submit__: "1"` via data_exchange
 *  - Server handler checks for `__submit__` to distinguish update vs. final save
 *
 * Supported question types:
 *   "list"     -> Dropdown      (best for 3-10 options)
 *   "button"   -> RadioButtons  (best for 2-5 options)
 *   "multi"    -> CheckboxGroup (best for multi-select, 2+ options)
 *   "text"     -> TextInput
 *   "textarea" -> TextArea
 *   "date"     -> DatePicker
 */

export type QuestionType = 'list' | 'button' | 'multi' | 'text' | 'textarea' | 'date';

export interface FlowCondition {
  /** The question ID whose answer controls visibility of this question */
  dependsOn: string;
  /** The answer value (sanitized) that makes this question appear */
  equals: string;
}

export interface FlowQuestion {
  id: string;
  text: string;
  type: QuestionType;
  options?: string[];
  required?: boolean;
  placeholder?: string;
  sectionTitle?: string;
  showIf?: FlowCondition;
  /** If true, user can select multiple options (multi-select / checkbox style) */
  allowMultiple?: boolean;
}

export interface MetaFlowQuestion extends FlowQuestion {}
export interface MetaFlowSurveyDefinition {
  id?: string;
  name: string;
  description?: string;
  questions: FlowQuestion[];
  thankYouText?: string;
}

interface FlowParams {
  id?: string;
  name: string;
  description?: string;
  questions: FlowQuestion[];
  thankYouText?: string;
}

// --- Helpers ------------------------------------------------------------------

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max - 1) + '...' : str;
}

export function sanitizeOptionId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Data variable name for a conditional question's visibility flag */
export function visibilityVar(questionId: string): string {
  return `show_${questionId}`;
}

/**
 * Given the current answers map, compute which conditional questions should be visible.
 * Returns a data object like: { show_satisfaction_reason: true, show_improvement: false }
 */
export function computeVisibilityData(
  questions: FlowQuestion[],
  answers: Record<string, string>,
): Record<string, boolean> {
  const data: Record<string, boolean> = {};
  for (const q of questions) {
    if (!q.showIf) continue;
    const depAnswer = answers[q.showIf.dependsOn] ?? '';
    // Meta sends back the sanitized option id (e.g. "Very_Dissatisfied")
    // showIf.equals may use the original string — sanitize both sides for comparison
    data[visibilityVar(q.id)] = sanitizeOptionId(depAnswer) === sanitizeOptionId(q.showIf.equals);
  }
  return data;
}

// --- Main Builder -------------------------------------------------------------

export function buildSurveyFlowJson(params: FlowParams, _endpointUrl: string): any {
  const { name, description, questions, thankYouText } = params;
  const hasConditionals = questions.some((q) => q.showIf);

  return hasConditionals
    ? buildDynamicFlow(name, description, questions, thankYouText)
    : buildSimpleFlow(name, description, questions, thankYouText);
}

// --- Simple flow (no conditionals) -------------------------------------------

function buildSimpleFlow(
  name: string,
  description: string | undefined,
  questions: FlowQuestion[],
  thankYouText: string | undefined,
): any {
  return {
    version: '7.0',
    data_api_version: '3.0',
    routing_model: { INTRO: ['QUESTIONS'], QUESTIONS: ['COMPLETE'], COMPLETE: [] },
    screens: [
      buildIntroScreen(name, description, 'QUESTIONS'),
      {
        id: 'QUESTIONS',
        title: truncate(name, 20),
        layout: {
          type: 'SingleColumnLayout',
          children: [
            ...questions.map((q) => buildComponent(q, false)),
            buildSubmitFooter(questions),
          ],
        },
      },
      buildCompleteScreen(thankYouText),
    ],
  };
}

// --- Dynamic flow (with conditionals via data_exchange visibility) ------------

function buildDynamicFlow(
  name: string,
  description: string | undefined,
  questions: FlowQuestion[],
  thankYouText: string | undefined,
): any {
  const conditionalQuestions = questions.filter((q) => q.showIf);
  const parentIds = new Set(conditionalQuestions.map((q) => q.showIf!.dependsOn));

  // Screen data block -- visibility flags for every conditional question, all false initially
  const screenData: Record<string, any> = {};
  for (const q of conditionalQuestions) {
    screenData[visibilityVar(q.id)] = {
      type: 'boolean',
      '__example__': false,
    };
  }

  const components: any[] = [];

  for (const q of questions) {
    const isParent = parentIds.has(q.id);
    const isConditional = !!q.showIf;

    const component = buildComponent(q, isParent);

    if (isConditional) {
      // Hidden until server says show
      component.visible = `\${data.${visibilityVar(q.id)}}`;
      // Conditional fields are never required (they might be hidden)
      component.required = false;
    }

    components.push(component);
  }

  return {
    version: '7.0',
    data_api_version: '3.0',
    routing_model: { INTRO: ['QUESTIONS'], QUESTIONS: ['COMPLETE'], COMPLETE: [] },
    screens: [
      buildIntroScreen(name, description, 'QUESTIONS'),
      {
        id: 'QUESTIONS',
        title: truncate(name, 20),
        data: screenData,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            ...components,
            buildSubmitFooter(questions),
          ],
        },
      },
      buildCompleteScreen(thankYouText),
    ],
  };
}

// --- Component builders -------------------------------------------------------

function buildComponent(q: FlowQuestion, isParent: boolean): any {
  const required = q.required !== false;

  switch (q.type) {
    case 'list': {
      const comp: any = {
        type: 'Dropdown',
        label: truncate(q.text, 80),
        name: q.id,
        required,
        'data-source': (q.options || []).map((opt) => ({
          id: sanitizeOptionId(opt),
          title: truncate(opt, 30),
        })),
        ...(q.placeholder ? { 'helper-text': truncate(q.placeholder, 80) } : {}),
      };
      if (isParent) {
        comp['on-select-action'] = {
          name: 'data_exchange',
          payload: { [q.id]: `\${form.${q.id}}` },
        };
      }
      return comp;
    }
    case 'button': {
      const comp: any = {
        type: 'RadioButtonsGroup',
        label: truncate(q.sectionTitle || q.text, 30),
        name: q.id,
        required,
        'data-source': (q.options || []).map((opt) => ({
          id: sanitizeOptionId(opt),
          title: truncate(opt, 30),
        })),
      };
      if (isParent) {
        comp['on-select-action'] = {
          name: 'data_exchange',
          payload: { [q.id]: `\${form.${q.id}}` },
        };
      }
      return comp;
    }
    case 'multi': {
      const comp: any = {
        type: 'CheckboxGroup',
        label: truncate(q.sectionTitle || q.text, 30),
        name: q.id,
        required: false, // multi-select is never required (user can skip)
        'data-source': (q.options || []).map((opt) => ({
          id: sanitizeOptionId(opt),
          title: truncate(opt, 30),
        })),
      };
      // If this multi-select is a parent for conditional questions, trigger data_exchange on any change
      if (isParent) {
        comp['on-select-action'] = {
          name: 'data_exchange',
          payload: { [q.id]: `\${form.${q.id}}` },
        };
      }
      return comp;
    }
    case 'textarea':
      return {
        type: 'TextArea',
        label: truncate(q.text, 80),
        name: q.id,
        required,
        ...(q.placeholder ? { 'helper-text': truncate(q.placeholder, 80) } : {}),
      };
    case 'date':
      return {
        type: 'DatePicker',
        label: truncate(q.text, 80),
        name: q.id,
        required,
      };
    case 'text':
    default:
      return {
        type: 'TextInput',
        label: truncate(q.text, 80),
        name: q.id,
        required,
        'input-type': 'text',
        ...(q.placeholder ? { 'helper-text': truncate(q.placeholder, 80) } : {}),
      };
  }
}

function buildSubmitFooter(questions: FlowQuestion[]): any {
  const payload: Record<string, string> = { __submit__: '1' };
  for (const q of questions) {
    payload[q.id] = `\${form.${q.id}}`;
  }
  return {
    type: 'Footer',
    label: 'Submit',
    'on-click-action': {
      name: 'data_exchange',
      payload,
    },
  };
}

// --- Shared screen builders ---------------------------------------------------

function buildIntroScreen(name: string, description: string | undefined, firstScreen: string): any {
  return {
    id: 'INTRO',
    title: truncate(name, 20),
    layout: {
      type: 'SingleColumnLayout',
      children: [
        { type: 'TextHeading', text: truncate(name, 80) },
        { type: 'TextBody', text: description || 'Please complete this survey.' },
        {
          type: 'Footer',
          label: 'Start Survey',
          'on-click-action': {
            name: 'navigate',
            next: { type: 'screen', name: firstScreen },
            payload: {},
          },
        },
      ],
    },
  };
}

function buildCompleteScreen(thankYouText: string | undefined): any {
  return {
    id: 'COMPLETE',
    title: 'Done',
    terminal: true,
    layout: {
      type: 'SingleColumnLayout',
      children: [
        { type: 'TextHeading', text: 'Thank You!' },
        { type: 'TextBody', text: thankYouText || 'Your feedback has been received.' },
        {
          type: 'Footer',
          label: 'Close',
          'on-click-action': { name: 'complete', payload: {} },
        },
      ],
    },
  };
}

// --- Deprecated multi-screen helpers (kept for import compatibility) ----------
/** @deprecated Use computeVisibilityData instead */
export function nextScreenAfter(
  _questions: FlowQuestion[],
  _currentIndex: number,
  _answers: Record<string, string>,
): string {
  return 'COMPLETE';
}
/** @deprecated No longer used */
export function questionScreenId(_i: number): string {
  return 'QUESTIONS';
}
