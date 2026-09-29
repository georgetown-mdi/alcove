import type { PayloadColumn } from "../../src/config/linkageTermsSchema";
import type { MessageConnection } from "../../src/connection/messageConnection";

/**
 * `conn` with every terms frame it sends stating `send` as the payload columns
 * its party sends, whatever that party's terms state: a partner whose terms
 * misstate what it transmits, which only the received-payload check meets.
 */
export function misstatingPayloadSend(
  conn: MessageConnection,
  send: PayloadColumn[],
): MessageConnection {
  return {
    send: (frame: unknown) => {
      if (
        typeof frame !== "object" ||
        frame === null ||
        !("linkageTerms" in frame)
      )
        return conn.send(frame);
      const terms = (frame as { linkageTerms: { payload?: object } })
        .linkageTerms;
      return conn.send({
        ...frame,
        linkageTerms: { ...terms, payload: { ...terms.payload, send } },
      });
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
    setInboundFrameCap: conn.setInboundFrameCap?.bind(conn),
  };
}
