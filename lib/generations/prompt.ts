// Prompts are never silently truncated. This is only a request-size safety
// boundary; callers must return a clear validation error above this limit.
export const MAX_GENERATION_PROMPT_CHARS = 50_000;

export function appendPromptInstruction(basePrompt: string, heading: string, instruction: string) {
  return `${basePrompt.trim()}\n\n${heading}\n${instruction.trim()}`.trim();
}
