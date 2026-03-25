import { createRoomService } from "../../lib/room-service.js";
import { readJson, sendError, sendJson, sendMethodNotAllowed } from "../_shared/http.js";

let service;

function getService() {
  if (!service) service = createRoomService();
  return service;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const body = await readJson(req);
    const result = await getService().createRoom(body.adminName || "Admin");
    return sendJson(res, 201, result);
  } catch (error) {
    return sendError(res, error);
  }
}
