import { defineRoom, defineServer } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { LAND_ROOM } from "@linked-realms/shared";
import { LandRoom, type LandRoomOptions } from "./LandRoom.ts";

export function createServer(options: LandRoomOptions) {
  return defineServer({
    transport: new WebSocketTransport(),
    rooms: { [LAND_ROOM]: defineRoom(LandRoom, options) },
  });
}
