import type { Mock } from "vitest";

import type { NextSecretInputs, TermsRotation } from "@alcove/core";

/** The next secret a mocked runExchange stores. */
export const MOCKED_NEXT_SECRET = "rotated";

/** Inputs a mocked handshake hands the run; the mocked runExchange reads none
 * of their bytes. */
export const MOCKED_NEXT_SECRET_INPUTS: NextSecretInputs = {
  negotiatedProtocolVersion: 1,
  sessionKey: new Uint8Array(32),
  keyAgreementOutput: new Uint8Array(32),
  initiatorValue: new Uint8Array(32),
  expires: undefined,
};

const inputsReadBeforeStore = new WeakMap<TermsRotation, NextSecretInputs>();

/** The inputs a mocked runExchange read off `rotation` before its store, as
 * the real terms exchange reads them for the derivation. */
export function inputsReadAtStore(
  rotation: TermsRotation,
): NextSecretInputs | undefined {
  return inputsReadBeforeStore.get(rotation);
}

/**
 * Make every implementation a mocked runExchange takes store
 * {@link MOCKED_NEXT_SECRET} through `options.rotation` first, as the real
 * terms exchange does before any payload round, reading its inputs before the
 * store ({@link inputsReadAtStore}). Patches the mock's
 * `mockImplementation` and `mockImplementationOnce`, which its
 * `mockResolvedValue` and `mockRejectedValue` families call.
 */
export function storeRotationFirst(mock: Mock): void {
  const storingFirst =
    (impl: (...args: Array<unknown>) => unknown) =>
    async (...args: Array<unknown>): Promise<unknown> => {
      const rotation = (args[3] as { rotation?: TermsRotation } | undefined)
        ?.rotation;
      if (rotation !== undefined) {
        inputsReadBeforeStore.set(rotation, rotation.inputs);
        await rotation.store(MOCKED_NEXT_SECRET);
      }
      return impl(...args);
    };
  const setImplementation = mock.mockImplementation.bind(mock);
  const setImplementationOnce = mock.mockImplementationOnce.bind(mock);
  mock.mockImplementation = (impl) =>
    setImplementation(
      storingFirst(impl as (...args: Array<unknown>) => unknown),
    );
  mock.mockImplementationOnce = (impl) =>
    setImplementationOnce(
      storingFirst(impl as (...args: Array<unknown>) => unknown),
    );
  // The implementation the mock was created with, if any, stores first too.
  const initial = mock.getMockImplementation();
  if (initial !== undefined) mock.mockImplementation(initial);
}
