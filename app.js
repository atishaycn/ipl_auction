import { AUCTION_RULES, AUCTION_SETTINGS } from "./data.js";

const app = document.getElementById("app");

const route = parseRoute();
const state = {
  route,
  room: null,
  auth: {
    isAdmin: false,
    member: loadStoredMember(route.roomId),
  },
  ui: {
    search: "",
    filter: "available",
    selectedPlayerId: null,
    joinRole: "spectator",
    error: null,
  },
};

render();
if (route.roomId) loadRoom().catch((error) => presentError(error.message || "Failed to load room."));

function parseRoute() {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[0] === "room" && parts[1]) return { mode: "room", roomId: parts[1].toUpperCase() };
  if (parts[0] === "public" && parts[1]) return { mode: "public", roomId: parts[1].toUpperCase() };
  return { mode: "landing", roomId: "" };
}

function memberStorageKey(roomId) {
  return roomId ? `ipl-room-member:${roomId}` : "ipl-room-member";
}

function loadStoredMember(roomId) {
  try {
    return JSON.parse(localStorage.getItem(memberStorageKey(roomId)) || "null");
  } catch {
    return null;
  }
}

function storeMember(roomId, member) {
  localStorage.setItem(memberStorageKey(roomId), JSON.stringify(member));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

function presentError(message) {
  state.ui.error = {
    title: "Action blocked",
    message,
  };
  render();
}

function dismissError() {
  state.ui.error = null;
  render();
}

async function withErrorPopup(task) {
  try {
    await task();
  } catch (error) {
    presentError(error.message || "Request failed.");
  }
}

async function refreshRoom({ fatal = false } = {}) {
  if (!state.route.roomId) return;
  try {
    const params = new URLSearchParams();
    if (state.auth.member?.memberToken) params.set("memberToken", state.auth.member.memberToken);
    if (adminKey()) params.set("adminKey", adminKey());
    const payload = await fetchJson(`/api/rooms/${state.route.roomId}/state?${params.toString()}`);
    state.room = payload.room;
    state.auth = payload.auth;
    if (!state.ui.selectedPlayerId || !state.room.players.some((player) => player.id === state.ui.selectedPlayerId)) {
      state.ui.selectedPlayerId = state.room.currentNomination?.playerId || firstAvailablePlayerId();
    }
    render();
  } catch (error) {
    if (fatal) throw error;
    console.warn(error);
  }
}

async function loadRoom() {
  await refreshRoom({ fatal: true });
}

function adminKey() {
  return new URLSearchParams(location.search).get("admin") || "";
}

function currentActorPayload() {
  if (state.auth.isAdmin) return { adminKey: adminKey() };
  if (state.auth.member?.memberToken) return { memberToken: state.auth.member.memberToken };
  return {};
}

async function action(type, detail = {}) {
  const payload = await fetchJson(`/api/rooms/${state.route.roomId}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, ...detail, ...currentActorPayload() }),
  });
  await refreshRoom({ fatal: false });
  return payload;
}

function firstAvailablePlayerId() {
  return state.room?.players.find((player) => player.status === "available")?.id || null;
}

function formatAmount(lakh) {
  return `₹${(Number(lakh) / 100).toFixed(2)} cr`;
}

function auctionRulesPanel() {
  const facts = [
    `Purse ${formatAmount(AUCTION_SETTINGS.purse)}`,
    `${AUCTION_SETTINGS.minPlayers}-${AUCTION_SETTINGS.maxPlayers} players`,
    `Entry fee ₹${AUCTION_SETTINGS.entryFee}`,
    `Split ${AUCTION_SETTINGS.payoutSplit.join(":")}`,
  ].map((item) => `<span class="rule-chip">${escapeHtml(item)}</span>`).join("");

  return `
    <section class="rules-panel">
      <div class="panel-head compact rules-head">
        <div>
          <h2>Auction rules</h2>
          <p>These are the settlement rules and the live-room constraints enforced by the room.</p>
        </div>
        <div class="rules-facts">${facts}</div>
      </div>
      <ul class="rules-list">
        ${AUCTION_RULES.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}
      </ul>
    </section>
  `;
}

function selectedPlayer() {
  if (!state.room) return null;
  return state.room.players.find((player) => player.id === state.ui.selectedPlayerId) || null;
}

function currentNominationPlayer() {
  if (!state.room?.currentNomination) return null;
  return state.room.players.find((player) => player.id === state.room.currentNomination.playerId) || null;
}

function turnOwnerText(nomination) {
  const owner = nomination?.currentTurnOwnerId
    ? state.room.owners.find((entry) => entry.id === nomination.currentTurnOwnerId)
    : null;
  if (!owner) return "Waiting for the next turn.";
  return `${escapeHtml(owner.name)} is on turn now.`;
}

function ownerRoster(ownerId) {
  return state.room.players.filter((player) => player.soldTo?.ownerId === ownerId);
}

function sortedOwners() {
  return [...state.room.owners].sort((left, right) => {
    if (right.rosterCount !== left.rosterCount) return right.rosterCount - left.rosterCount;
    return right.purseRemainingLakh - left.purseRemainingLakh;
  });
}

function playerFilters() {
  const search = state.ui.search.trim().toLowerCase();
  const orderIndex = new Map((state.room.playerOrder || []).map((playerId, index) => [playerId, index]));
  return state.room.players
    .filter((player) => {
    const matchesFilter = state.ui.filter === "all" ? true : player.status === state.ui.filter;
    const matchesSearch = !search || `${player.name} ${player.team} ${player.category}`.toLowerCase().includes(search);
    return matchesFilter && matchesSearch;
    })
    .sort((left, right) => (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER));
}

function render() {
  if (state.route.mode === "landing") {
    app.innerHTML = landingView();
    bindLandingEvents();
    return;
  }

  if (!state.room) {
    app.innerHTML = shell(`<section class="loading-state"><p>Loading room…</p></section>`);
    return;
  }

  const body = state.route.mode === "public" ? publicRoomView() : commandCenterView();
  app.innerHTML = shell(body);
  bindRoomEvents();
}

function shell(body) {
  return `
    <div class="app-shell mode-${state.route.mode}">
      <header class="top-strip">
        <a class="brand" href="/">
          <span class="brand-mark">IPL</span>
          <span class="brand-text">
            <strong>Auction Command Center</strong>
            <small>${state.route.mode === "public" ? "Public live board" : "Operator workspace"}</small>
          </span>
        </a>
        ${state.room ? headerMeta() : ""}
      </header>
      ${body}
      ${state.ui.error ? errorOverlay(state.ui.error) : ""}
    </div>
  `;
}

function errorOverlay(error) {
  return `
    <div class="error-overlay" role="alertdialog" aria-modal="true" aria-labelledby="errorTitle">
      <div class="error-sheet">
        <div class="error-kicker">Warning</div>
        <h2 id="errorTitle">${escapeHtml(error.title)}</h2>
        <p>${escapeHtml(error.message)}</p>
        <div class="error-actions">
          <button type="button" id="errorDismissBtn">Dismiss</button>
        </div>
      </div>
    </div>
  `;
}

function headerMeta() {
  return `
    <div class="header-meta">
      <span>Room ${escapeHtml(state.room.roomId)}</span>
      <span>Code ${escapeHtml(state.room.inviteCode)}</span>
      <span class="status-pill status-${state.room.status}">${labelStatus(state.room.status)}</span>
    </div>
  `;
}

function landingView() {
  return `
    <div class="landing">
      <section class="landing-stage">
        <div class="landing-copy">
          <div class="kicker">Fantasy IPL Auction</div>
          <h1>Run the room like an auction floor, not a spreadsheet.</h1>
          <p>Create a live room, share the code, and run turn-based bidding from a queue of IPL players while the public board updates in real time.</p>
          <form id="createRoomForm" class="landing-actions">
            <input id="adminName" placeholder="Host name" value="Admin" />
            <button type="submit">Create Auction Room</button>
          </form>
        </div>
        <div class="landing-utility">
          <h2>Join an existing room</h2>
          <form id="goRoomForm" class="stack-form">
            <input id="roomIdInput" placeholder="Room ID" />
            <div class="inline-choice">
              <button type="submit">Open command center</button>
              <button type="button" id="openPublicBtn" class="ghost">Open public board</button>
            </div>
          </form>
          <ul class="plain-list">
            <li>173-player pool preloaded from the PDF</li>
            <li>Open -> bid -> sold/unsold workflow</li>
            <li>Separate public board and admin room</li>
          </ul>
        </div>
      </section>
    </div>
  `;
}

function commandCenterView() {
  const nomination = state.room.currentNomination;
  const stagePlayer = currentNominationPlayer();
  const activeOwner = nomination?.currentLeaderOwnerId ? state.room.owners.find((owner) => owner.id === nomination.currentLeaderOwnerId) : null;
  const turnOwner = nomination?.currentTurnOwnerId ? state.room.owners.find((owner) => owner.id === nomination.currentTurnOwnerId) : null;
  const activeBidders = nomination
    ? (nomination.turnOrderOwnerIds || []).filter((ownerId) => {
        const owner = state.room.owners.find((entry) => entry.id === ownerId);
        return owner && owner.rosterCount < state.room.settings.maxPlayers && !(nomination.skippedOwnerIds || []).includes(ownerId);
      })
    : [];
  const visiblePlayers = playerFilters();
  const soldPlayers = state.room.soldOrder.map((playerId) => state.room.players.find((player) => player.id === playerId)).filter(Boolean).reverse();
  const bidEvents = state.room.history.filter((entry) => entry.type === "bid").slice(-12).reverse();

  return `
    <main class="workspace">
      <section class="auction-stage">
        <div class="stage-copy">
          <div class="stage-kicker">On The Block</div>
          <h1>${stagePlayer ? escapeHtml(stagePlayer.name) : "Waiting for the next player"}</h1>
          <p>${stagePlayer ? `${escapeHtml(stagePlayer.team)} · ${stagePlayer.category} pool · ${stagePlayer.overseas ? "Overseas" : "Domestic"}` : "Start the auction and the room will auto-advance through the queue."}</p>
        </div>
        <div class="stage-metrics">
          <div>
            <span>Base</span>
            <strong>${stagePlayer ? formatAmount(stagePlayer.baseCostLakh) : "—"}</strong>
          </div>
          <div>
            <span>Live bid</span>
            <strong>${nomination?.currentBidLakh ? formatAmount(nomination.currentBidLakh) : nomination ? "No bid yet" : "—"}</strong>
          </div>
          <div>
            <span>Leader</span>
            <strong>${activeOwner ? escapeHtml(activeOwner.name) : "No bids yet"}</strong>
          </div>
          <div>
            <span>Turn</span>
            <strong>${turnOwner ? escapeHtml(turnOwner.name) : "Waiting"}</strong>
          </div>
        </div>
        <div class="stage-status">
          <span class="status-pill status-${nomination?.status || state.room.status}">${nomination ? labelStatus(nomination.status) : labelStatus(state.room.status)}</span>
          <span>${state.room.owners.length} owners</span>
          <span>${state.room.players.filter((player) => player.status === "sold").length} sold</span>
          <span>${state.room.players.filter((player) => player.status === "available").length} available</span>
          <span>${activeBidders.length} active bidders</span>
        </div>
        ${auctionRulesPanel()}
        ${adminStageControls(stagePlayer, nomination)}
        ${ownerBidPanel(nomination)}
      </section>

      <aside class="owner-rail">
        <div class="rail-head">
          <h2>Owners</h2>
          <p>Purse and roster tracking update when a player is sold.</p>
        </div>
        <div class="owner-list">
          ${sortedOwners().map((owner) => `
            <article class="owner-row ${nomination?.currentLeaderOwnerId === owner.id ? "is-leading" : ""} ${nomination?.currentTurnOwnerId === owner.id ? "is-turn" : ""}">
              <div>
                <strong>${escapeHtml(owner.name)}</strong>
                <span>${owner.claimed ? `Claimed by ${escapeHtml(owner.claimedName || owner.name)}` : "Unclaimed"}</span>
              </div>
              <div class="owner-stats">
                <span>${formatAmount(owner.purseRemainingLakh)}</span>
                <span>${owner.rosterCount}/${state.room.settings.maxPlayers}</span>
              </div>
            </article>
          `).join("") || `<div class="empty-state">Add owners before the room goes live.</div>`}
        </div>
        <div class="rail-footer">
          <h3>Room Access</h3>
          <div class="link-stack">
            <label><span>Command room</span><input readonly value="${location.origin}/room/${state.room.roomId}" /></label>
            <label><span>Public board</span><input readonly value="${location.origin}/public/${state.room.roomId}" /></label>
          </div>
        </div>
      </aside>

      <section class="workspace-lower">
        <div class="pool-panel">
          <div class="panel-head">
            <div>
              <h2>Available Pool</h2>
              <p>Search the full player database and review the fixed auction queue directly from here.</p>
            </div>
            <div class="panel-tools">
              <input id="playerSearch" placeholder="Search player or team" value="${escapeHtml(state.ui.search)}" />
              <div class="segmented">
                ${["available", "live", "sold", "unsold", "all"].map((filter) => `
                  <button type="button" class="segment ${state.ui.filter === filter ? "active" : ""}" data-filter="${filter}">${labelStatus(filter)}</button>
                `).join("")}
              </div>
            </div>
          </div>
          <div class="pool-list">
            ${visiblePlayers.map((player) => `
              <button type="button" class="pool-row ${state.ui.selectedPlayerId === player.id ? "selected" : ""}" data-player-id="${player.id}">
                <span class="player-col">
                  <strong>${escapeHtml(player.name)}</strong>
                  <small>${escapeHtml(player.team)} · ${player.category}${player.overseas ? " · Overseas" : ""}</small>
                </span>
                <span class="player-col">
                  <small>${labelStatus(player.status)}</small>
                  <strong>${player.soldTo ? formatAmount(player.soldTo.amountLakh) : formatAmount(player.baseCostLakh)}</strong>
                </span>
              </button>
            `).join("") || `<div class="empty-state">No players match this filter.</div>`}
          </div>
        </div>

        <div class="log-panel">
          <section class="subpanel">
            <div class="panel-head compact">
              <div>
                <h2>Bid Ladder</h2>
                <p>Most recent live calls in the room.</p>
              </div>
            </div>
            <div class="event-list">
              ${bidEvents.map((event) => `
                <article class="event-row">
                  <strong>${escapeHtml(event.message)}</strong>
                  <span>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </article>
              `).join("") || `<div class="empty-state">No bids yet.</div>`}
            </div>
          </section>

          <section class="subpanel">
            <div class="panel-head compact">
              <div>
                <h2>Sold Log</h2>
                <p>Closed lots in sale order.</p>
              </div>
            </div>
            <div class="event-list">
              ${soldPlayers.map((player) => `
                <article class="event-row">
                  <strong>${escapeHtml(player.name)}</strong>
                  <span>${escapeHtml(player.soldTo.ownerName)} · ${formatAmount(player.soldTo.amountLakh)}</span>
                </article>
              `).join("") || `<div class="empty-state">Nothing sold yet.</div>`}
            </div>
          </section>

          <section class="subpanel">
            <div class="panel-head compact">
              <div>
                <h2>Auction Log</h2>
                <p>Operational history for undo and review.</p>
              </div>
            </div>
            <div class="event-list">
              ${state.room.history.slice().reverse().slice(0, 20).map((event) => `
                <article class="event-row tone-${event.type}">
                  <strong>${escapeHtml(event.message)}</strong>
                  <span>${escapeHtml(event.actor)} · ${new Date(event.at).toLocaleString()}</span>
                </article>
              `).join("")}
            </div>
          </section>
        </div>
      </section>
      ${joinOverlay()}
    </main>
  `;
}

function publicRoomView() {
  const nomination = state.room.currentNomination;
  const stagePlayer = currentNominationPlayer();
  const leader = nomination?.currentLeaderOwnerId ? state.room.owners.find((owner) => owner.id === nomination.currentLeaderOwnerId) : null;
  const turnOwner = nomination?.currentTurnOwnerId ? state.room.owners.find((owner) => owner.id === nomination.currentTurnOwnerId) : null;
  return `
    <main class="public-board">
      <section class="public-stage">
        <div>
          <div class="stage-kicker">Public Board</div>
          <h1>${stagePlayer ? escapeHtml(stagePlayer.name) : "Waiting for the next nomination"}</h1>
          <p>${stagePlayer ? `${escapeHtml(stagePlayer.team)} · ${stagePlayer.category} pool` : "The auction board updates automatically when the room changes."}</p>
        </div>
        <div class="public-matrix">
          <div><span>Status</span><strong>${nomination ? labelStatus(nomination.status) : labelStatus(state.room.status)}</strong></div>
          <div><span>Current bid</span><strong>${nomination?.currentBidLakh ? formatAmount(nomination.currentBidLakh) : "No bid yet"}</strong></div>
          <div><span>Leader</span><strong>${leader ? escapeHtml(leader.name) : "—"}</strong></div>
          <div><span>Turn</span><strong>${turnOwner ? escapeHtml(turnOwner.name) : "—"}</strong></div>
          <div><span>Sold lots</span><strong>${state.room.players.filter((player) => player.status === "sold").length}</strong></div>
        </div>
        ${auctionRulesPanel()}
      </section>

      <section class="public-grid">
        <div class="projection-list">
          <h2>Owners</h2>
          ${sortedOwners().map((owner) => `
            <div class="projection-row">
              <strong>${escapeHtml(owner.name)}</strong>
              <span>${formatAmount(owner.purseRemainingLakh)}</span>
              <span>${owner.rosterCount} players</span>
            </div>
          `).join("")}
        </div>
        <div class="projection-list">
          <h2>Recent Calls</h2>
          ${state.room.history.slice().reverse().slice(0, 12).map((event) => `
            <div class="projection-row">
              <strong>${escapeHtml(event.message)}</strong>
              <span>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          `).join("")}
        </div>
      </section>
    </main>
  `;
}

function adminStageControls(stagePlayer, nomination) {
  if (!state.auth.isAdmin) return "";
  const canStart = !nomination && state.room.status === "setup";
  return `
    <section class="control-strip">
      <div class="control-group">
        <h2>Admin Controls</h2>
        <p>Start the room, pause it, undo mistakes, or manually mark a lot unsold if needed.</p>
      </div>
      <div class="action-row">
        <button type="button" data-action="start" ${canStart ? "" : "disabled"}>${canStart ? "Start auction" : state.room.status === "completed" ? "Auction completed" : state.room.status === "paused" ? "Auction paused" : "Auction already running"}</button>
        <button type="button" data-action="unsold" ${nomination ? "" : "disabled"} class="ghost">Mark unsold</button>
        <button type="button" data-action="undo" class="ghost">Undo</button>
        <button type="button" data-action="pause" class="ghost">${state.room.status === "paused" ? "Resume" : "Pause"}</button>
        <button type="button" data-action="complete" class="ghost">Complete room</button>
      </div>
      <form id="addOwnerForm" class="inline-toolbar">
        <input id="ownerNameInput" placeholder="Add owner before the room goes live" />
        <button type="submit">Add owner</button>
      </form>
    </section>
  `;
}

function ownerBidPanel(nomination) {
  const member = state.auth.member;
  if (!nomination) {
    return `<section class="bid-panel muted-panel"><p>No active bidding yet. The admin needs to start the auction.</p></section>`;
  }

  if (state.auth.isAdmin) {
    return `
      <section class="bid-panel">
        <div class="panel-head compact">
          <div>
            <h2>Turn Flow</h2>
            <p>Bidding is turn-based. Owners bid only when it is their turn.</p>
          </div>
        </div>
      </section>
    `;
  }

  if (member?.role === "owner") {
    const owner = state.room.owners.find((entry) => entry.id === member.ownerId);
    const isCurrentTurn = nomination.currentTurnOwnerId === member.ownerId;
    return `
      <section class="bid-panel">
        <div class="panel-head compact">
          <div>
            <h2>Your Bid Lane</h2>
            <p>${owner ? `${escapeHtml(owner.name)} · ${formatAmount(owner.purseRemainingLakh)} remaining` : "Owner session not claimed."}</p>
          </div>
        </div>
        ${isCurrentTurn
          ? `
            <form id="ownerBidForm" class="inline-toolbar">
              <input id="ownerBidAmount" type="number" step="0.01" min="0.01" placeholder="${nomination.currentBidLakh === null ? "Any positive amount" : `Above ${formatAmount(nomination.currentBidLakh)}`}" />
              <button type="submit">Place bid</button>
              <button type="button" id="ownerSkipBtn" class="ghost">Skip turn</button>
            </form>
          `
          : `
            <div class="muted-panel">
              <p>${turnOwnerText(nomination)}</p>
            </div>
          `}
      </section>
    `;
  }

  return `<section class="bid-panel muted-panel"><p>Spectators can watch the live board here. Owners bid only from their claimed team seat.</p></section>`;
}

function joinOverlay() {
  if (state.route.mode !== "room" || state.auth.isAdmin || state.auth.member) return "";
  const availableOwners = state.room.owners.filter((owner) => !owner.claimed);
  return `
    <div class="join-overlay">
      <form id="joinRoomForm" class="join-sheet">
        <div>
          <div class="kicker">Room Entry</div>
          <h2>Join the auction room</h2>
          <p>Use the invite code to enter as a spectator or claim an owner seat.</p>
        </div>
        <input id="joinDisplayName" placeholder="Your display name" />
        <input id="joinCode" placeholder="Invite code" />
        <select id="joinRole">
          <option value="spectator">Spectator</option>
          <option value="owner">Owner</option>
        </select>
        <select id="joinOwnerId">
          <option value="">Select owner seat</option>
          ${availableOwners.map((owner) => `<option value="${owner.id}">${escapeHtml(owner.name)}</option>`).join("")}
        </select>
        <button type="submit">Enter room</button>
      </form>
    </div>
  `;
}

function labelStatus(status) {
  const map = {
    setup: "Setup",
    live: "Live",
    paused: "Paused",
    completed: "Completed",
    available: "Available",
    sold: "Sold",
    unsold: "Unsold",
    nominated: "Nominated",
    open: "Turn Active",
    "last-call": "Last Call",
    all: "All",
  };
  return map[status] || status;
}

function bindLandingEvents() {
  document.getElementById("createRoomForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await withErrorPopup(async () => {
      const adminName = document.getElementById("adminName").value.trim() || "Admin";
      const payload = await fetchJson("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminName }),
      });
      location.href = `/room/${payload.room.roomId}?admin=${payload.adminKey}`;
    });
  });

  const roomInput = document.getElementById("roomIdInput");
  document.getElementById("goRoomForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const roomId = roomInput.value.trim().toUpperCase();
    if (roomId) location.href = `/room/${roomId}`;
  });
  document.getElementById("openPublicBtn")?.addEventListener("click", () => {
    const roomId = roomInput.value.trim().toUpperCase();
    if (roomId) location.href = `/public/${roomId}`;
  });
}

function bindRoomEvents() {
  document.getElementById("errorDismissBtn")?.addEventListener("click", dismissError);

  document.getElementById("playerSearch")?.addEventListener("input", (event) => {
    state.ui.search = event.target.value;
    render();
  });

  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.filter = button.dataset.filter;
      render();
    });
  });

  document.querySelectorAll("[data-player-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ui.selectedPlayerId = button.dataset.playerId;
      render();
    });
  });

  document.getElementById("joinRoomForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await withErrorPopup(async () => {
      const role = document.getElementById("joinRole").value;
      const payload = await fetchJson(`/api/rooms/${state.route.roomId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: document.getElementById("joinCode").value.trim().toUpperCase(),
          role,
          ownerId: document.getElementById("joinOwnerId").value,
          displayName: document.getElementById("joinDisplayName").value.trim() || "Guest",
          memberToken: state.auth.member?.memberToken || "",
        }),
      });
      state.auth.member = payload.member;
      storeMember(state.route.roomId, payload.member);
      await loadRoom();
    });
  });

  document.getElementById("addOwnerForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await withErrorPopup(async () => {
      const name = document.getElementById("ownerNameInput").value.trim();
      if (!name) return;
      await action("add-owner", { name });
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      await withErrorPopup(async () => {
        const type = button.dataset.action;
        if (type === "start") await action("start-auction");
        if (type === "unsold") await action("mark-unsold");
        if (type === "undo") await action("undo-last-action");
        if (type === "pause") await action(state.room.status === "paused" ? "resume-auction" : "pause-auction");
        if (type === "complete") await action("complete-room");
      });
    });
  });

  document.getElementById("ownerBidForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await withErrorPopup(async () => {
      const bidCr = Number(document.getElementById("ownerBidAmount").value);
      await action("place-bid", { amountLakh: Math.round(bidCr * 100) });
    });
  });

  document.getElementById("ownerSkipBtn")?.addEventListener("click", async () => {
    await withErrorPopup(async () => {
      await action("skip-turn");
    });
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}
