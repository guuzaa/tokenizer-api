export type CountFn = (text: string) => number;

/** One chat-template family. Matching, rendering, and the prompt cap belong together. */
export interface ModelFamily {
  /** Family id, for example `deepseek-v4`. This is not the caller's model string. */
  readonly name: string;
  /** Default prompt cap. `handleCount` uses the `MAX_PROMPT_BYTES` var when it is valid. */
  readonly maxPromptBytes: number;
  matches(model: string): boolean;
  render(body: Record<string, unknown>): string;
}

/** A family plus the tokenizer that counts the prompt it renders. */
export interface Model extends ModelFamily {
  countTokens: CountFn;
}
