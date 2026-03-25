import { createRoomService } from "../../../lib/room-service.js";
import { readJson, sendError, sendJson, sendMethodNotAllowed } from "../../_shared/http.js";

let service;

function getService() {
  if (!service) service = createRoomService();
  return service;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const roomId = String(req.query.roomId || "").toUpperCase();
    const body = await readJson(req);
    const result = await getService().performAction(roomId, body);
    if (!result) return sendJson(res, 404, { error: "Room not found." });
    return sendJson(res, 200, result);
  } catch (error) {
    return sendError(res, error);
  }
}
