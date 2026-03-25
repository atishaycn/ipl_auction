import http from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUCTION_SETTINGS, PLAYER_POOL } from "./data.js";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = join(__dirname, "rooms-state.json");
const VERSION = 3;
const PLAYER_LOOKUP = new Map(PLAYER_POOL.map((player) => [player.name, player]));

function buildPlayers() {
  return PLAYER_POOL.map((player) => ({
    ...player,
    status: "available",
    soldTo: null,
  }));
}

function buildPlayerOrder(players) {
  return players
    .map((player, index) => ({
      id: player.id || `p_${index + 1}`,
      baseCostLakh: Number.isFinite(player.baseCostLakh) ? player.baseCostLakh : Number(player.cost || 0),
      index,
    }))
    .sort((left, right) => right.baseCostLakh - left.baseCostLakh || left.index - right.index)
    .map((player) => player.id);
}

function normalizePlayer(player, index) {
  const template = PLAYER_POOL[index] || PLAYER_LOOKUP.get(player?.name) || {};
  return {
    ...template,
    ...player,
    id: player?.id || template.id || `p_${index + 1}`,
    name: player?.name || template.name || `Player ${index + 1}`,
    team: template.team || player?.team || "Unknown",
    category: template.category || player?.category || "Unknown",
    cost: Number.isFinite(player?.cost)
      ? player.cost
      : Number.isFinite(player?.baseCostLakh)
        ? player.baseCostLakh
        : template.cost ?? template.baseCostLakh ?? 0,
    baseCostLakh: Number.isFinite(player?.baseCostLakh)
      ? player.baseCostLakh
      : Number.isFinite(player?.cost)
        ? player.cost
        : template.baseCostLakh ?? template.cost ?? 0,
    overseas: typeof player?.overseas === "boolean" ? player.overseas : Boolean(template.overseas),
    status: player?.status || (player?.soldTo ? "sold" : "available"),
    soldTo: player?.soldTo
      ? {
          ...player.soldTo,
          amountLakh: Number.isFinite(player.soldTo.amountLakh) ? player.soldTo.amountLakh : Number(player.soldTo.amount || 0),
          soldAt: player.soldTo.soldAt || player.soldTo.at || new Date().toISOString(),
        }
      : null,
  };
}

function normalizeOwner(owner, room) {
  return {
    ...owner,
    purseRemainingLakh: Number.isFinite(owner?.purseRemainingLakh) ? owner.purseRemainingLakh : room.settings.purseLakh,
    rosterCount: Number.isFinite(owner?.rosterCount) ? owner.rosterCount : 0,
  };
}

function recomputeOwners(room) {
  const ownersById = new Map(room.owners.map((owner) => [owner.id, normalizeOwner(owner, room)]));
  const soldPlayers = room.players.filter((player) => player.soldTo?.ownerId);

  for (const player of soldPlayers) {
    const owner = ownersById.get(player.soldTo.ownerId);
    if (!owner) continue;
    owner.rosterCount += 1;
    owner.purseRemainingLakh -= Number(player.soldTo.amountLakh || player.soldTo.amount || 0);
  }

  room.owners = [...ownersById.values()];
}

function buildTurnOrder(room, startingBidLakh) {
  return room.owners
    .filter((owner) => owner.rosterCount < room.settings.maxPlayers && owner.purseRemainingLakh >= startingBidLakh)
    .map((owner) => owner.id);
}

function sanitizeIdList(ids, validIds) {
  const valid = new Set(validIds);
  const result = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!valid.has(id) || result.includes(id)) continue;
    result.push(id);
  }
  return result;
}

function normalizeNomination(room) {
  if (!room.currentNomination) return;

  const nomination = room.currentNomination;
  const player = getPlayer(room, nomination.playerId);

  if (!player) {
    room.currentNomination = null;
    return;
  }

  const rawStatus = nomination.status || "open";
  nomination.status = rawStatus === "nominated" || rawStatus === "last-call" ? "open" : rawStatus;
  nomination.startingBidLakh = Number.isFinite(nomination.startingBidLakh) ? nomination.startingBidLakh : player.baseCostLakh;
  nomination.currentBidLakh = Number.isFinite(nomination.currentBidLakh) ? nomination.currentBidLakh : null;
  nomination.currentLeaderOwnerId = nomination.currentLeaderOwnerId || null;
  nomination.bidStepLakh = Number.isFinite(nomination.bidStepLakh) ? nomination.bidStepLakh : room.settings.minBidStepLakh || 5;
  nomination.turnOrderOwnerIds = sanitizeIdList(
    nomination.turnOrderOwnerIds,
    room.owners.map((owner) => owner.id),
  );
  if (!nomination.turnOrderOwnerIds.length) {
    nomination.turnOrderOwnerIds = buildTurnOrder(room, nomination.startingBidLakh);
  }
  nomination.skippedOwnerIds = sanitizeIdList(nomination.skippedOwnerIds, nomination.turnOrderOwnerIds);
  nomination.currentTurnOwnerId = nomination.currentTurnOwnerId && nomination.turnOrderOwnerIds.includes(nomination.currentTurnOwnerId)
    ? nomination.currentTurnOwnerId
    : nomination.turnOrderOwnerIds.find((ownerId) => !nomination.skippedOwnerIds.includes(ownerId)) || null;
  nomination.openedAt = nomination.openedAt || null;
  nomination.closedAt = nomination.closedAt || null;
}

function normalizeRoom(room) {
  const sourcePurse = Number.isFinite(room.settings?.purseLakh)
    ? room.settings.purseLakh
    : Number.isFinite(room.settings?.purse)
      ? room.settings.purse
      : Number.isFinite(AUCTION_SETTINGS.purseLakh)
        ? AUCTION_SETTINGS.purseLakh
        : AUCTION_SETTINGS.purse;
  const purseLakh = sourcePurse < 1000 ? sourcePurse * 100 : sourcePurse;

  room.version = VERSION;
  room.settings = {
    ...AUCTION_SETTINGS,
    ...room.settings,
    purse: purseLakh,
    purseLakh,
    minPlayers: Number.isFinite(room.settings?.minPlayers) ? room.settings.minPlayers : AUCTION_SETTINGS.minPlayers,
    maxPlayers: Number.isFinite(room.settings?.maxPlayers) ? room.settings.maxPlayers : AUCTION_SETTINGS.maxPlayers,
    payoutSplit: Array.isArray(room.settings?.payoutSplit) ? room.settings.payoutSplit : AUCTION_SETTINGS.payoutSplit,
  };
  room.status = room.status || (room.paused ? "paused" : "setup");
  room.players = Array.isArray(room.players) ? room.players.map((player, index) => normalizePlayer(player, index)) : buildPlayers();
  room.owners = Array.isArray(room.owners) ? room.owners.map((owner) => normalizeOwner(owner, room)) : [];
  room.playerOrder = Array.isArray(room.playerOrder) && room.playerOrder.length === room.players.length
    ? sanitizeIdList(room.playerOrder, room.players.map((player) => player.id))
    : buildPlayerOrder(room.players);
  room.currentNomination = room.currentNomination || null;
  room.history = Array.isArray(room.history) ? room.history : [];
  room.soldOrder = Array.isArray(room.soldOrder) ? room.soldOrder : [];
  room.undoStack = Array.isArray(room.undoStack) ? room.undoStack : [];
  room.createdAt = room.createdAt || new Date().toISOString();
  room.updatedAt = room.updatedAt || room.createdAt;

  recomputeOwners(room);
  normalizeNomination(room);
}

function createRoom(adminName = "Admin") {
  const sourcePurse = Number.isFinite(AUCTION_SETTINGS.purseLakh) ? AUCTION_SETTINGS.purseLakh : AUCTION_SETTINGS.purse;
  const purseLakh = sourcePurse < 1000 ? sourcePurse * 100 : sourcePurse;
  const players = buildPlayers();

  return {
    version: VERSION,
    roomId: randomUUID().slice(0, 6).toUpperCase(),
    inviteCode: randomUUID().slice(0, 6).toUpperCase(),
    adminKey: randomUUID(),
    adminName,
    status: "setup",
    settings: { ...AUCTION_SETTINGS, purse: purseLakh, purseLakh },
    owners: [],
    players,
    playerOrder: buildPlayerOrder(players),
    currentNomination: null,
    history: [],
    soldOrder: [],
    undoStack: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function loadRooms() {
  if (!existsSync(DATA_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, "utf8"));
    const migrated = {};
    for (const [roomId, room] of Object.entries(parsed)) {
      if (!room) continue;
      migrated[roomId] = room.version === VERSION ? room : { ...room };
      normalizeRoom(migrated[roomId]);
    }
    return migrated;
  } catch {
    return {};
  }
}

const rooms = loadRooms();
const subscribers = new Map();

if (existsSync(DATA_FILE)) {
  writeFileSync(DATA_FILE, JSON.stringify(rooms, null, 2));
}

function saveRooms() {
  writeFileSync(DATA_FILE, JSON.stringify(rooms, null, 2));
}

function getRoom(roomId) {
  return rooms[roomId] || null;
}

function serializeRoom(room) {
  return {
    roomId: room.roomId,
    inviteCode: room.inviteCode,
    adminName: room.adminName,
    status: room.status,
    settings: room.settings,
    playerOrder: room.playerOrder,
    owners: room.owners.map((owner) => ({
      id: owner.id,
      name: owner.name,
      purseRemainingLakh: owner.purseRemainingLakh,
      rosterCount: owner.rosterCount,
      claimed: Boolean(owner.claimToken),
      claimedName: owner.claimedName || null,
      status: owner.rosterCount < room.settings.minPlayers ? "short" : "ready",
    })),
    players: room.players,
    currentNomination: room.currentNomination,
    history: room.history.slice(-80),
    soldOrder: room.soldOrder,
    updatedAt: room.updatedAt,
    createdAt: room.createdAt,
  };
}

function roomSnapshot(room) {
  return structuredClone({
    status: room.status,
    owners: room.owners,
    players: room.players,
    playerOrder: room.playerOrder,
    currentNomination: room.currentNomination,
    soldOrder: room.soldOrder,
  });
}

function restoreSnapshot(room, snapshot) {
  room.status = snapshot.status;
  room.owners = snapshot.owners;
  room.players = snapshot.players;
  room.playerOrder = snapshot.playerOrder;
  room.currentNomination = snapshot.currentNomination;
  room.soldOrder = snapshot.soldOrder;
}

function broadcast(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const payload = `data: ${JSON.stringify({ type: "room:update", room: serializeRoom(room) })}\n\n`;
  for (const res of subscribers.get(roomId) || []) res.write(payload);
}

function writeEvent(room, type, actor, message, detail = {}) {
  room.history.push({
    id: randomUUID().slice(0, 8),
    type,
    actor,
    message,
    detail,
    at: new Date().toISOString(),
  });
}

function commit(room, actionLabel, actor, mutate) {
  const snapshot = roomSnapshot(room);
  const undoDepth = room.undoStack.length;
  const historyDepth = room.history.length;
  try {
    mutate(room);
  } catch (error) {
    restoreSnapshot(room, snapshot);
    room.history = room.history.slice(0, historyDepth);
    room.undoStack = room.undoStack.slice(0, undoDepth);
    throw error;
  }
  room.undoStack.push({
    id: randomUUID().slice(0, 8),
    actionLabel,
    actor,
    snapshot,
  });
  room.updatedAt = new Date().toISOString();
  saveRooms();
  broadcast(room.roomId);
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  const ext = extname(filePath);
  res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
  res.end(readFileSync(filePath));
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }
}

function getPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId);
}

function getOwner(room, ownerId) {
  return room.owners.find((owner) => owner.id === ownerId);
}

function ensureMutable(room) {
  assert(room.status !== "paused", "Auction is paused.");
  assert(room.status !== "completed", "Auction is already completed.");
}

function getActor(body, room) {
  if (body.adminKey && body.adminKey === room.adminKey) {
    return { role: "admin", name: room.adminName };
  }
  if (body.memberToken) {
    const owner = room.owners.find((entry) => entry.claimToken === body.memberToken);
    if (owner) return { role: "owner", name: owner.claimedName || owner.name, ownerId: owner.id };
  }
  const error = new Error("Unauthorized action.");
  error.statusCode = 403;
  throw error;
}

function createMemberResponse(owner, displayName) {
  return {
    role: "owner",
    memberToken: owner.claimToken,
    ownerId: owner.id,
    displayName: displayName || owner.claimedName || owner.name,
  };
}

function formatLakh(amountLakh) {
  return `₹${(amountLakh / 100).toFixed(2)} cr`;
}

function validNominationOwners(room, nomination) {
  return nomination.turnOrderOwnerIds.filter((ownerId) => {
    const owner = getOwner(room, ownerId);
    return Boolean(owner) && owner.rosterCount < room.settings.maxPlayers && !nomination.skippedOwnerIds.includes(ownerId);
  });
}

function nextOwnerInTurnOrder(activeOwnerIds, fromOwnerId) {
  if (!activeOwnerIds.length) return null;
  const index = activeOwnerIds.indexOf(fromOwnerId);
  if (index === -1) return activeOwnerIds[0];
  return activeOwnerIds[(index + 1) % activeOwnerIds.length];
}

function createNomination(room, player) {
  const startingBidLakh = Number.isFinite(player.baseCostLakh) ? player.baseCostLakh : player.cost || 0;
  const turnOrderOwnerIds = buildTurnOrder(room, startingBidLakh);
  return {
    playerId: player.id,
    status: "open",
    startingBidLakh,
    currentBidLakh: null,
    currentLeaderOwnerId: null,
    bidStepLakh: room.settings.minBidStepLakh || 5,
    turnOrderOwnerIds,
    skippedOwnerIds: [],
    currentTurnOwnerId: turnOrderOwnerIds[0] || null,
    openedAt: new Date().toISOString(),
    closedAt: null,
  };
}

function startNextPlayer(room, actorName, detail = {}) {
  while (true) {
    const nextPlayer = room.playerOrder
      .map((playerId) => getPlayer(room, playerId))
      .find((player) => player && player.status === "available");

    if (!nextPlayer) {
      room.currentNomination = null;
      room.status = "completed";
      writeEvent(room, "complete", actorName, "Auction completed.", detail);
      return;
    }

    nextPlayer.status = "live";
    room.currentNomination = createNomination(room, nextPlayer);
    room.status = "live";
    writeEvent(room, "start-player", actorName, `${nextPlayer.name} is now on the block at ${formatLakh(room.currentNomination.startingBidLakh)}.`, {
      playerId: nextPlayer.id,
      startingBidLakh: room.currentNomination.startingBidLakh,
      ...detail,
    });

    const activeOwners = validNominationOwners(room, room.currentNomination);
    if (!activeOwners.length) {
      nextPlayer.status = "unsold";
      room.currentNomination = null;
      writeEvent(room, "unsold", actorName, `${nextPlayer.name} marked unsold because no owners were eligible.`, {
        playerId: nextPlayer.id,
        ...detail,
      });
      continue;
    }

    room.currentNomination.currentTurnOwnerId = activeOwners[0];
    return;
  }
}

function sellCurrentNomination(room, actorName, reason = "sold") {
  const nomination = room.currentNomination;
  if (!nomination) return;
  const player = getPlayer(room, nomination.playerId);
  const owner = getOwner(room, nomination.currentLeaderOwnerId);
  assert(player && owner, "Auction state is invalid.");
  assert(Number.isFinite(nomination.currentBidLakh), "No valid bid to close.");
  assert(owner.purseRemainingLakh >= nomination.currentBidLakh, `${owner.name} no longer has purse room.`);
  assert(owner.rosterCount < room.settings.maxPlayers, `${owner.name} cannot take more players.`);

  player.status = "sold";
  player.soldTo = {
    ownerId: owner.id,
    ownerName: owner.name,
    amountLakh: nomination.currentBidLakh,
    soldAt: new Date().toISOString(),
  };
  owner.purseRemainingLakh -= nomination.currentBidLakh;
  owner.rosterCount += 1;
  room.soldOrder.push(player.id);
  room.currentNomination = null;
  nomination.closedAt = new Date().toISOString();
  writeEvent(room, reason, actorName, `${player.name} sold to ${owner.name} for ${formatLakh(player.soldTo.amountLakh)}.`, {
    playerId: player.id,
    ownerId: owner.id,
    amountLakh: player.soldTo.amountLakh,
  });
}

function markCurrentUnsold(room, actorName, message = "marked unsold") {
  const nomination = room.currentNomination;
  if (!nomination) return;
  const player = getPlayer(room, nomination.playerId);
  assert(player, "Player not found.");
  player.status = "unsold";
  nomination.closedAt = new Date().toISOString();
  room.currentNomination = null;
  writeEvent(room, "unsold", actorName, `${player.name} ${message}.`, { playerId: player.id });
}

function finalizeNomination(room, actorName) {
  const nomination = room.currentNomination;
  if (!nomination) return;

  const activeOwnerIds = validNominationOwners(room, nomination);
  const leaderId = nomination.currentLeaderOwnerId;

  if (!leaderId && activeOwnerIds.length === 0) {
    markCurrentUnsold(room, actorName, "had no eligible bidders and was marked unsold");
    startNextPlayer(room, actorName);
    return;
  }

  if (leaderId && (activeOwnerIds.length === 0 || (activeOwnerIds.length === 1 && activeOwnerIds[0] === leaderId))) {
    sellCurrentNomination(room, actorName);
    startNextPlayer(room, actorName);
    return;
  }

  if (!nomination.currentTurnOwnerId || !activeOwnerIds.includes(nomination.currentTurnOwnerId)) {
    nomination.currentTurnOwnerId = nextOwnerInTurnOrder(activeOwnerIds, nomination.currentTurnOwnerId || leaderId);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/") return sendFile(res, join(__dirname, "index.html"));
  if (url.pathname.startsWith("/room/")) return sendFile(res, join(__dirname, "index.html"));
  if (url.pathname.startsWith("/public/")) return sendFile(res, join(__dirname, "index.html"));
  if (url.pathname === "/styles.css") return sendFile(res, join(__dirname, "styles.css"));
  if (url.pathname === "/app.js") return sendFile(res, join(__dirname, "app.js"));
  if (url.pathname === "/data.js") return sendFile(res, join(__dirname, "data.js"));

  try {
    if (url.pathname === "/api/rooms" && req.method === "POST") {
      const body = await readJson(req);
      const room = createRoom(body.adminName || "Admin");
      rooms[room.roomId] = room;
      writeEvent(room, "room-created", "system", `Room ${room.roomId} created.`);
      saveRooms();
      return send(res, 201, { room: serializeRoom(room), adminKey: room.adminKey });
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(state|join|events|action))?$/);
    if (!roomMatch) return send(res, 404, { error: "Not found." });

    const room = getRoom(roomMatch[1].toUpperCase());
    if (!room) return send(res, 404, { error: "Room not found." });
    const action = roomMatch[2];

    if (!action || (action === "state" && req.method === "GET")) {
      const memberToken = url.searchParams.get("memberToken") || "";
      const memberOwner = room.owners.find((owner) => owner.claimToken === memberToken);
      const isAdmin = url.searchParams.get("adminKey") === room.adminKey;
      return send(res, 200, {
        room: serializeRoom(room),
        auth: {
          isAdmin,
          member: memberOwner
            ? createMemberResponse(memberOwner)
            : memberToken
              ? { role: "spectator", memberToken, displayName: "Spectator" }
              : null,
        },
      });
    }

    if (action === "join" && req.method === "POST") {
      const body = await readJson(req);
      assert(body.code && body.code.toUpperCase() === room.inviteCode, "Invalid invite code.");
      const role = body.role || "spectator";

      if (role === "spectator") {
        return send(res, 200, {
          room: serializeRoom(room),
          member: {
            role: "spectator",
            memberToken: body.memberToken || randomUUID(),
            displayName: body.displayName || "Spectator",
          },
        });
      }

      assert(role === "owner", "Unsupported role.");
      const owner = getOwner(room, body.ownerId);
      assert(owner, "Owner not found.");
      if (owner.claimToken && owner.claimToken !== body.memberToken) {
        const error = new Error("This owner is already claimed.");
        error.statusCode = 409;
        throw error;
      }
      owner.claimToken = body.memberToken || randomUUID();
      owner.claimedName = body.displayName || owner.name;
      room.updatedAt = new Date().toISOString();
      writeEvent(room, "claim-owner", owner.claimedName, `${owner.name} claimed from a remote seat.`);
      saveRooms();
      broadcast(room.roomId);
      return send(res, 200, { room: serializeRoom(room), member: createMemberResponse(owner, body.displayName) });
    }

    if (action === "events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      const set = subscribers.get(room.roomId) || new Set();
      set.add(res);
      subscribers.set(room.roomId, set);
      req.on("close", () => set.delete(res));
      res.write(`data: ${JSON.stringify({ type: "room:update", room: serializeRoom(room) })}\n\n`);
      return;
    }

    if (action === "action" && req.method === "POST") {
      const body = await readJson(req);
      const actor = getActor(body, room);

      if (body.type === "add-owner") {
        assert(actor.role === "admin", "Admin only.");
        assert(room.status === "setup", "Add owners before the auction goes live.");
        assert(body.name && body.name.trim(), "Owner name is required.");
        commit(room, "add-owner", actor.name, (draft) => {
          const duplicate = draft.owners.some((owner) => owner.name.toLowerCase() === body.name.trim().toLowerCase());
          assert(!duplicate, "Owner already exists.");
          draft.owners.push({
            id: randomUUID().slice(0, 8),
            name: body.name.trim(),
            purseRemainingLakh: draft.settings.purseLakh,
            rosterCount: 0,
            claimToken: null,
            claimedName: null,
          });
          writeEvent(draft, "add-owner", actor.name, `Owner ${body.name.trim()} added.`);
        });
        return send(res, 200, { ok: true });
      }

      if (body.type === "start-auction") {
        assert(actor.role === "admin", "Admin only.");
        assert(room.status === "setup", "Auction already started.");
        assert(!room.currentNomination, "Auction is already in progress.");
        commit(room, "start-auction", actor.name, (draft) => {
          draft.status = "live";
          startNextPlayer(draft, actor.name);
        });
        return send(res, 200, { ok: true });
      }

      if (body.type === "skip-turn") {
        ensureMutable(room);
        assert(room.currentNomination, "No active player on the block.");
        assert(["open"].includes(room.currentNomination.status), "Bidding is not active.");
        commit(room, "skip-turn", actor.name, (draft) => {
          const nomination = draft.currentNomination;
          const ownerId = actor.role === "admin" ? body.ownerId : actor.ownerId;
          const owner = getOwner(draft, ownerId);
          assert(owner, "Owner not found.");
          assert(nomination.currentTurnOwnerId === owner.id, "It is not this owner's turn.");
          if (!nomination.skippedOwnerIds.includes(owner.id)) nomination.skippedOwnerIds.push(owner.id);
          const player = getPlayer(draft, nomination.playerId);
          writeEvent(draft, "skip", actor.name, `${owner.name} skips ${player.name}.`, {
            playerId: player.id,
            ownerId: owner.id,
          });
          nomination.currentTurnOwnerId = nextOwnerInTurnOrder(validNominationOwners(draft, nomination), owner.id);
          finalizeNomination(draft, actor.name);
        });
        return send(res, 200, { ok: true });
      }

      if (body.type === "place-bid") {
        ensureMutable(room);
        assert(room.currentNomination, "No active player on the block.");
        assert(["open"].includes(room.currentNomination.status), "Bidding is not active.");
        commit(room, "place-bid", actor.name, (draft) => {
          const nomination = draft.currentNomination;
          const player = getPlayer(draft, nomination.playerId);
          const ownerId = actor.role === "admin" ? body.ownerId : actor.ownerId;
          const owner = getOwner(draft, ownerId);
          assert(owner, "Owner not found.");
          assert(nomination.currentTurnOwnerId === owner.id, "It is not this owner's turn.");
          const amountLakh = Math.round(Number(body.amountLakh));
          assert(Number.isFinite(amountLakh) && amountLakh > 0, "Invalid bid amount.");
          const minimum = nomination.currentBidLakh === null
            ? nomination.startingBidLakh
            : nomination.currentBidLakh + nomination.bidStepLakh;
          assert(amountLakh >= minimum, `Bid must be at least ${formatLakh(minimum)}.`);
          assert(owner.purseRemainingLakh >= amountLakh, `${owner.name} does not have enough purse.`);
          assert(owner.rosterCount < draft.settings.maxPlayers, `${owner.name} already has ${draft.settings.maxPlayers} players.`);
          nomination.currentBidLakh = amountLakh;
          nomination.currentLeaderOwnerId = owner.id;
          nomination.currentTurnOwnerId = nextOwnerInTurnOrder(validNominationOwners(draft, nomination), owner.id);
          nomination.openedAt = nomination.openedAt || new Date().toISOString();
          writeEvent(draft, "bid", actor.name, `${owner.name} bids ${formatLakh(amountLakh)} for ${player.name}.`, {
            playerId: player.id,
            ownerId: owner.id,
            amountLakh,
          });
          finalizeNomination(draft, actor.name);
        });
        return send(res, 200, { ok: true });
      }

      if (body.type === "mark-unsold") {
        assert(actor.role === "admin", "Admin only.");
        ensureMutable(room);
        assert(room.currentNomination, "No active nomination.");
        commit(room, "mark-unsold", actor.name, (draft) => {
          markCurrentUnsold(draft, actor.name);
          startNextPlayer(draft, actor.name);
        });
        return send(res, 200, { ok: true });
      }

      if (body.type === "pause-auction") {
        assert(actor.role === "admin", "Admin only.");
        assert(room.status !== "completed", "Auction is completed.");
        commit(room, "pause-auction", actor.name, (draft) => {
          draft.status = "paused";
          writeEvent(draft, "pause", actor.name, "Auction paused.");
        });
        return send(res, 200, { ok: true });
      }

      if (body.type === "resume-auction") {
        assert(actor.role === "admin", "Admin only.");
        assert(room.status === "paused", "Auction is not paused.");
        commit(room, "resume-auction", actor.name, (draft) => {
          draft.status = draft.currentNomination ? "live" : "setup";
          writeEvent(draft, "resume", actor.name, "Auction resumed.");
        });
        return send(res, 200, { ok: true });
      }

      if (body.type === "undo-last-action") {
        assert(actor.role === "admin", "Admin only.");
        const undoEntry = room.undoStack.pop();
        assert(undoEntry, "Nothing to undo.");
        restoreSnapshot(room, undoEntry.snapshot);
        room.updatedAt = new Date().toISOString();
        writeEvent(room, "undo", actor.name, `Undid ${undoEntry.actionLabel}.`);
        saveRooms();
        broadcast(room.roomId);
        return send(res, 200, { ok: true });
      }

      if (body.type === "complete-room") {
        assert(actor.role === "admin", "Admin only.");
        assert(!room.currentNomination, "Finish the current player before completing the room.");
        commit(room, "complete-room", actor.name, (draft) => {
          const incomplete = draft.owners.filter((owner) => owner.rosterCount < draft.settings.minPlayers);
          assert(incomplete.length === 0, "Every owner must have at least 11 players.");
          draft.status = "completed";
          writeEvent(draft, "complete", actor.name, "Auction completed.");
        });
        return send(res, 200, { ok: true });
      }

      if (body.type === "reset-room") {
        assert(actor.role === "admin", "Admin only.");
        const fresh = createRoom(room.adminName);
        fresh.roomId = room.roomId;
        fresh.inviteCode = room.inviteCode;
        fresh.adminKey = room.adminKey;
        rooms[room.roomId] = fresh;
        writeEvent(fresh, "reset", actor.name, "Room reset.");
        saveRooms();
        broadcast(fresh.roomId);
        return send(res, 200, { ok: true });
      }

      return send(res, 400, { error: "Unknown action." });
    }

    return send(res, 405, { error: "Method not allowed." });
  } catch (error) {
    return send(res, error.statusCode || 500, { error: error.message || "Server error." });
  }
});

server.listen(PORT, () => {
  console.log(`IPL auction server running at http://localhost:${PORT}`);
});
