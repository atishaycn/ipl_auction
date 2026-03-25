import { createRoom, getAuthForRoom, joinRoom, publicRoom, normalizeRoom, applyAction } from "./auction.js";
import { createRoomStore } from "./room-store.js";

function roomCreatedEvent(room) {
  room.history.push({
    id: "room-created",
    type: "room-created",
    actor: "system",
    message: `Room ${room.roomId} created.`,
    detail: {},
    at: new Date().toISOString(),
  });
}

export function createRoomService(store = createRoomStore()) {
  return {
    async createRoom(adminName = "Admin") {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = normalizeRoom(createRoom(adminName));
        roomCreatedEvent(room);
        const created = await store.createRoom(room).catch((error) => {
          if (error.statusCode === 409 || error.statusCode === 23505) return null;
          throw error;
        });
        if (created) {
          return {
            room: publicRoom(created),
            adminKey: created.adminKey,
          };
        }
      }

      const error = new Error("Unable to create a unique room.");
      error.statusCode = 500;
      throw error;
    },

    async getRoomState(roomId, query = {}) {
      const room = await store.getRoom(roomId);
      if (!room) return null;
      return {
        room: publicRoom(room),
        auth: getAuthForRoom(room, query),
      };
    },

    async joinRoom(roomId, body = {}) {
      let result = null;
      const room = await store.updateRoom(roomId, (draft) => {
        result = joinRoom(draft, body);
      });
      return room ? {
        room: publicRoom(room),
        member: result?.member || null,
      } : null;
    },

    async performAction(roomId, body = {}) {
      const room = await store.updateRoom(roomId, (draft) => {
        applyAction(draft, body);
      });
      return room ? { ok: true, room: publicRoom(room) } : null;
    },
  };
}
