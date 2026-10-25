/** The model calls the agent needs. The OpenAI client implements this; tests use a fake. */

export type DecisionQuestion =
  | { type: 'predicate'; name: string; instructions: string }
  | {
      type: 'choice';
      name: string;
      instructions: string;
      choices: Array<{ value: string; description: string }>;
    };

export type DecisionAnswer =
  | { type: 'predicate'; name: string; probability: number }
  | {
      type: 'choice';
      name: string;
      choice: string;
      probabilities: Array<{ value: string; probability: number }>;
      confidence: number;
    }
  | { type: 'refusal'; name: string | null };

export interface StructuredRequest {
  instructions: string;
  input: string;
  schemaName: string;
  /** A strict-mode JSON Schema: every object has additionalProperties false and lists all properties as required. */
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface TextStreamRequest {
  instructions: string;
  input: string;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}

export interface LlmClient {
  /** OpenAI Decisions API: typed answers (probabilities and choices), no generated text. */
  decide(input: string, questions: DecisionQuestion[], signal?: AbortSignal): Promise<DecisionAnswer[]>;
  /** Responses API with Structured Outputs. Returns the parsed JSON; callers validate it. */
  structured(request: StructuredRequest): Promise<unknown>;
  /** Responses API with streaming. Calls onDelta for each text fragment and resolves with the full text. */
  streamText(request: TextStreamRequest): Promise<string>;
}

export class ModelRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRefusalError';
  }
}
