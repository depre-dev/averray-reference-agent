export class ToolError extends Error {
  constructor(
    message: string,
    public readonly details: unknown = undefined
  ) {
    super(message);
  }
}

