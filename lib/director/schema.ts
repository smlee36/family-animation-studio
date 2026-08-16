export const DIRECTOR_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "scenes"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 80 },
    summary: { type: "string", minLength: 1, maxLength: 400 },
    scenes: {
      type: "array",
      minItems: 1,
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary", "setting", "sceneMasterReferenceId", "shots"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 80 },
          summary: { type: "string", minLength: 1, maxLength: 300 },
          setting: { type: "string", minLength: 1, maxLength: 100 },
          sceneMasterReferenceId: { type: "string", maxLength: 80 },
          shots: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "title",
                "action",
                "estimatedSeconds",
                "referenceIds",
                "referenceReason",
                "startState",
                "endState",
                "prompt",
              ],
              properties: {
                title: { type: "string", minLength: 1, maxLength: 80 },
                action: { type: "string", minLength: 1, maxLength: 240 },
                estimatedSeconds: { type: "integer", minimum: 4, maximum: 8 },
                referenceIds: {
                  type: "array",
                  maxItems: 3,
                  items: { type: "string", maxLength: 80 },
                },
                referenceReason: { type: "string", maxLength: 240 },
                startState: { type: "string", minLength: 1, maxLength: 240 },
                endState: { type: "string", minLength: 1, maxLength: 240 },
                prompt: { type: "string", minLength: 1, maxLength: 1800 },
              },
            },
          },
        },
      },
    },
  },
} as const;
