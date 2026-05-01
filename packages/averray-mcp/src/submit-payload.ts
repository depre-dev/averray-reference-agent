export function buildSubmitRequestBody(input: {
  sessionId: string;
  output: unknown;
}) {
  return {
    sessionId: input.sessionId,
    submission: input.output
  };
}
