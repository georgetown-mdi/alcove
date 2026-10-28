/**
 * A managed run's data-exchange phase that stores `nextSecret` through the
 * rotation write it is handed, as core's terms exchange does before any
 * payload round, then runs `payload` on the handshake's value.
 */
export function rotatingDataExchange<TCarried, TExchange>(
  nextSecret: string,
  payload: (carried: TCarried) => TExchange | Promise<TExchange>,
): (
  carried: TCarried,
  persistNextSecret: (nextSecret: string) => Promise<void>,
) => Promise<TExchange> {
  return async (carried, persistNextSecret) => {
    await persistNextSecret(nextSecret);
    return payload(carried);
  };
}
