/**
 * Step 1: decide what the question is for and which tools it needs, with one
 * OpenAI Decisions API call (one choice + three predicates, answered together).
 */

import type { DecisionAnswer, LlmClient } from '../llm/types.ts';

export const PURPOSES = [
  { value: 'business_data', description: 'Needs figures, counts, totals, lists or other records from the business database.' },
  { value: 'business_documents', description: 'Needs information from business documents such as policies, procedures, contracts, manuals or notes.' },
  { value: 'data_and_documents', description: 'Needs both database records and business documents.' },
  { value: 'general', description: 'A general question that needs no business data or documents.' },
  { value: 'unclear', description: 'Too vague or incomplete to tell what is being asked.' },
  { value: 'other', description: 'None of the above.' },
] as const;

export type Purpose = (typeof PURPOSES)[number]['value'];

export interface RouteDecision {
  purpose: Purpose;
  purposeConfidence: number;
  needsDatabase: number;
  needsDocuments: number;
  isAmbiguous: number;
  useDatabase: boolean;
  useDocuments: boolean;
  clarify: boolean;
  /** Tools the question needs but this deployment doesn't have configured. */
  unavailable: Array<'database' | 'documents'>;
}

export interface RouterOptions {
  databaseAvailable: boolean;
  documentsAvailable: boolean;
  /** Short description of what's in the database (from the catalog). */
  databaseDescription: string;
  /** Short description of what's in the document library (DOCUMENTS_DESCRIPTION). */
  documentsDescription: string;
  predicateThreshold: number;
  clarifyThreshold: number;
}

export async function routeQuestion(
  llm: LlmClient,
  question: string,
  options: RouterOptions,
  signal?: AbortSignal,
): Promise<RouteDecision> {
  const input = [
    `Question: ${question}`,
    '',
    'Sources this assistant can use:',
    `- Business database: ${options.databaseAvailable ? options.databaseDescription : 'not available'}`,
    `- Business documents: ${options.documentsAvailable ? options.documentsDescription : 'not available'}`,
  ].join('\n');

  const answers = await llm.decide(
    input,
    [
      {
        type: 'choice',
        name: 'purpose',
        instructions: 'What is the purpose of this question, in terms of what is needed to answer it?',
        choices: PURPOSES.map((p) => ({ value: p.value, description: p.description })),
      },
      {
        type: 'predicate',
        name: 'needs_database',
        instructions: 'Answering requires looking up records, counts, totals, dates or other figures stored in the business database.',
      },
      {
        type: 'predicate',
        name: 'needs_documents',
        instructions: 'Answering requires information written in business documents such as policies, procedures, contracts, manuals or notes.',
      },
      {
        type: 'predicate',
        name: 'is_ambiguous',
        instructions:
          'The question is too vague to answer well without first asking the user a follow-up (for example it lacks which customer, which period or which measure).',
      },
    ],
    signal,
  );

  return decideRoute(answers, options);
}

/** Pure decision logic, separated so it can be tested without a model. */
export function decideRoute(answers: DecisionAnswer[], options: RouterOptions): RouteDecision {
  const byName = new Map(answers.map((a) => [a.name, a]));
  const purposeAnswer = byName.get('purpose');
  const purpose: Purpose =
    purposeAnswer?.type === 'choice' && PURPOSES.some((p) => p.value === purposeAnswer.choice)
      ? (purposeAnswer.choice as Purpose)
      : 'other';
  const purposeConfidence = purposeAnswer?.type === 'choice' ? purposeAnswer.confidence : 0;

  const probability = (name: string) => {
    const a = byName.get(name);
    return a?.type === 'predicate' ? a.probability : 0;
  };
  const needsDatabase = probability('needs_database');
  const needsDocuments = probability('needs_documents');
  const isAmbiguous = probability('is_ambiguous');

  const wantsDatabase =
    needsDatabase >= options.predicateThreshold || purpose === 'business_data' || purpose === 'data_and_documents';
  const wantsDocuments =
    needsDocuments >= options.predicateThreshold || purpose === 'business_documents' || purpose === 'data_and_documents';
  const clarify = isAmbiguous >= options.clarifyThreshold || (purpose === 'unclear' && purposeConfidence >= 0.5);

  const unavailable: RouteDecision['unavailable'] = [];
  if (wantsDatabase && !options.databaseAvailable) unavailable.push('database');
  if (wantsDocuments && !options.documentsAvailable) unavailable.push('documents');

  return {
    purpose,
    purposeConfidence,
    needsDatabase,
    needsDocuments,
    isAmbiguous,
    useDatabase: !clarify && wantsDatabase && options.databaseAvailable,
    useDocuments: !clarify && wantsDocuments && options.documentsAvailable,
    clarify,
    unavailable,
  };
}
