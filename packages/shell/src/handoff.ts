// A fresh arrival handoff for one Land (docs/protocols/arrival.md): a Travel ticket from the Hub,
// and the Character's arrival statement binding the ticket's nonce. The Shell always says the
// Character is not driven by an AI.
import {
  parseStatement,
  signStatement,
  type Handoff,
} from "@linked-realms/shared/identity";
import type { Account } from "./account.ts";
import type { HubClient } from "./hub.ts";
import type { Vault } from "./vault.ts";

export async function prepareHandoff(
  { account, hub, vault }: { account: Account; hub: HubClient; vault: Vault },
  landId: number,
  from?: number,
): Promise<Handoff> {
  const ticket = await account.call((token) => hub.ticket(token, landId, from));
  const fields = parseStatement("travel-ticket", ticket.statement);
  if (fields.land !== landId || fields.character !== vault.address)
    throw new Error("The Hub sent a ticket for another Land or Character");
  const arrival = vault.withKey((key) =>
    signStatement(
      "arrival",
      { land: landId, ticketNonce: fields.nonce, drivenByAi: false },
      key,
    ),
  );
  return { ticket, arrival };
}
