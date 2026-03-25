import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRoom } from "./auction.js";

const LIB_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ROOT_DIR = resolve(LIB_DIR, "..");
const DATA_FILE = join(ROOT_DIR, "rooms-state.json");

function hasSupabaseEnv() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function parseJson(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload;
  return payload;
}

function createSupabaseRequest(url, serviceKey) {
  return async function request(path, { method = "GET", body, params } = {}) {
    const requestUrl = new URL(`${url.replace(/\/$/, "")}/rest/v1/${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") requestUrl.searchParams.set(key, value);
      }
    }

    const headers = {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      accept: "application/json",
    };

    let payload;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers.prefer = "return=representation";
      payload = JSON.stringify(body);
    }

    const response = await fetch(requestUrl, { method, headers, body: payload });
    const text = await response.text();
    const data = text ? parseJsonSafe(text) : null;

    if (!response.ok) {
      const message = typeof data === "object" && data
        ? data.message || data.error || JSON.stringify(data)
        : text || `Supabase request failed (${response.status})`;
      const error = new Error(message);
      error.statusCode = response.status;
      throw error;
    }

    return data;
  };
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function hydrateRoomRow(row) {
  if (!row) return null;
  const room = {
    ...(row.state || {}),
    roomId: row.room_id || row.roomId || row.state?.roomId,
    inviteCode: row.invite_code || row.inviteCode || row.state?.inviteCode,
    adminKey: row.admin_key || row.adminKey || row.state?.adminKey,
    adminName: row.admin_name || row.adminName || row.state?.adminName,
    createdAt: row.created_at || row.createdAt || row.state?.createdAt,
    updatedAt: row.updated_at || row.updatedAt || row.state?.updatedAt,
  };
  return normalizeRoom(room);
}

function serializeRoomRow(room) {
  return {
    room_id: room.roomId,
    invite_code: room.inviteCode,
    admin_key: room.adminKey,
    admin_name: room.adminName,
    state: room,
    version: room.version || 1,
    created_at: room.createdAt,
    updated_at: room.updatedAt,
  };
}

function createFileStore() {
  let rooms = loadRooms();

  function loadRooms() {
    if (!existsSync(DATA_FILE)) return {};
    try {
      const parsed = JSON.parse(readFileSync(DATA_FILE, "utf8"));
      const next = {};
      for (const [roomId, room] of Object.entries(parsed)) {
        if (!room) continue;
        next[roomId] = normalizeRoom(room);
      }
      return next;
    } catch {
      return {};
    }
  }

  function saveRooms() {
    writeFileSync(DATA_FILE, JSON.stringify(rooms, null, 2));
  }

  return {
    async getRoom(roomId) {
      const room = rooms[roomId];
      return room ? normalizeRoom(room) : null;
    },
    async createRoom(room) {
      rooms[room.roomId] = normalizeRoom(room);
      saveRooms();
      return rooms[room.roomId];
    },
    async updateRoom(roomId, mutator) {
      const room = rooms[roomId];
      if (!room) return null;
      const draft = normalizeRoom(room);
      mutator(draft);
      rooms[roomId] = normalizeRoom(draft);
      saveRooms();
      return rooms[roomId];
    },
  };
}

function createSupabaseStore() {
  const request = createSupabaseRequest(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  return {
    async getRoom(roomId) {
      const rows = await request("rooms", {
        params: {
          select: "*",
          room_id: `eq.${roomId}`,
          limit: "1",
        },
      });
      return hydrateRoomRow(Array.isArray(rows) ? rows[0] : rows);
    },
    async createRoom(room) {
      const rows = await request("rooms", {
        method: "POST",
        body: [serializeRoomRow(room)],
      });
      return hydrateRoomRow(Array.isArray(rows) ? rows[0] : rows);
    },
    async updateRoom(roomId, mutator) {
      const rows = await request("rooms", {
        params: {
          select: "*",
          room_id: `eq.${roomId}`,
          limit: "1",
        },
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) return null;
      const current = hydrateRoomRow(row);
      mutator(current);
      const updatedRows = await request("rooms", {
        method: "PATCH",
        params: {
          room_id: `eq.${roomId}`,
        },
        body: serializeRoomRow(current),
      });
      return hydrateRoomRow(Array.isArray(updatedRows) ? updatedRows[0] : updatedRows);
    },
  };
}

export function createRoomStore() {
  if (hasSupabaseEnv()) return createSupabaseStore();
  if (process.env.VERCEL) {
    const error = new Error("Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.");
    error.statusCode = 500;
    throw error;
  }
  return createFileStore();
}
