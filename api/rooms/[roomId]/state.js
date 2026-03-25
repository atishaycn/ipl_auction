import { createRoomService } from "../../../lib/room-service.js";
import { sendError, sendJson, sendMethodNotAllowed } from "../../_shared/http.js";

let service;

function getService() {
  if (!service) service = createRoomService();
  return service;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const roomId = String(req.query.roomId || "").toUpperCase();
    const result = await getService().getRoomState(roomId, {
      memberToken: String(req.query.memberToken || ""),
      adminKey: String(req.query.adminKey || ""),
    });
    if (!result) return sendJson(res, 404, { error: "Room not found." });
    return sendJson(res, 200, result);
  } catch (error) {
    return sendError(res, error);
  }
}
