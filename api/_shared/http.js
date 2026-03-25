export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    return req.body ? JSON.parse(req.body) : {};
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
  }

  return body ? JSON.parse(body) : {};
}

export function sendJson(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.end(JSON.stringify(payload));
}

export function sendMethodNotAllowed(res, methods = []) {
  res.setHeader("allow", methods.join(", "));
  sendJson(res, 405, { error: "Method not allowed." });
}

export function sendError(res, error) {
  sendJson(res, error.statusCode || 500, {
    error: error.message || "Server error.",
  });
}
