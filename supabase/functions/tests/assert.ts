export function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export async function assertRejects(
  run: () => Promise<unknown> | unknown,
  expectedMessage: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof Error, "Expected an Error instance");
    assert(
      error.message.includes(expectedMessage),
      `Expected error containing ${expectedMessage}, got ${error.message}`,
    );
    return;
  }
  throw new Error("Expected function to reject");
}
