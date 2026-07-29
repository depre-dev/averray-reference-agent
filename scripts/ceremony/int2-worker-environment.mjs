const MODEL_ENVIRONMENT_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "HARNESS_BASELINE_MODEL",
  "HARNESS_GEMINI_API_KEY",
  "HARNESS_MODEL_ADAPTER",
  "HARNESS_MODEL_API_KEY",
  "HARNESS_MODEL_BASE_URL",
  "HARNESS_MODEL_REF",
  "HARNESS_OPENAI_API_KEY",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OPENAI_API_KEY",
]);

const SCRIPT_OVERRIDE =
  /^HARNESS_TEST_(?:(?:CHILD|EXECUTOR|JUDGE|PLANNER)_)?MODEL_(?:FACTORY_COUNTER|SCRIPT)(?:_[A-Z0-9_]+)?$/u;

export function createInt2WorkerEnvironment(
  environment,
  {
    databaseUrl,
    profilesRoot,
    modelScriptPath,
    artifactRoot,
  },
) {
  const controlled = { ...environment };
  for (const key of Object.keys(controlled)) {
    if (MODEL_ENVIRONMENT_KEYS.has(key) || SCRIPT_OVERRIDE.test(key)) {
      delete controlled[key];
    }
  }

  return {
    ...controlled,
    HARNESS_APP_VERSION: "pkt-003",
    HARNESS_ARTIFACT_ROOT: artifactRoot,
    HARNESS_DATABASE_URL: databaseUrl,
    HARNESS_MODEL_ADAPTER: "openai-compatible",
    HARNESS_MODEL_BASE_URL: "http://127.0.0.1",
    HARNESS_MODEL_REF: "int2-scripted-model",
    HARNESS_PROFILES_ROOT: profilesRoot,
    // Set every precedence level used by the pinned Harness to the same script.
    // A sourced operator environment therefore cannot shadow the test fixture.
    HARNESS_TEST_EXECUTOR_MODEL_SCRIPT_OPENAI_COMPATIBLE: modelScriptPath,
    HARNESS_TEST_EXECUTOR_MODEL_SCRIPT: modelScriptPath,
    HARNESS_TEST_MODEL_SCRIPT_OPENAI_COMPATIBLE: modelScriptPath,
    HARNESS_TEST_MODEL_SCRIPT: modelScriptPath,
  };
}
