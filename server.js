"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// ---- STATE STORES ----
const visitorSocketByLead = new Map();     // leadId -> socketId
const adminSocketsByLead = new Map();      // leadId -> Set(socketId)
const leadState = new Map();               // leadId -> { url, scrollX, scrollY, permission }

// ---- HELPERS ----
const room = (leadId) => `room-${leadId}`;

function ensureAdminSet(leadId) {
  if (!adminSocketsByLead.has(leadId)) {
    adminSocketsByLead.set(leadId, new Set());
  }
  return adminSocketsByLead.get(leadId);
}

// ---- SOCKET LOGIC ----
io.on("connection", (socket) => {
  socket.data = { role: null, leadId: null };

  socket.on("identify", ({ leadId, role }) => {
    leadId = String(leadId);
    socket.data.leadId = leadId;
    socket.data.role = role;

    socket.join(room(leadId));

    // Init state if missing
    if (!leadState.has(leadId)) {
      leadState.set(leadId, { permission: false });
    }

    if (role === "visitor") {
      visitorSocketByLead.set(leadId, socket.id);

      // Notify admins visitor is online
      socket.to(room(leadId)).emit("presence", { visitor: "online" });

    } else if (role === "admin") {
      ensureAdminSet(leadId).add(socket.id);

      const state = leadState.get(leadId);

      // Replay presence
      if (visitorSocketByLead.has(leadId)) {
        socket.emit("presence", { visitor: "online" });
      }

      // Replay permission
      if (state.permission) {
        socket.emit("permission-status", { granted: true });
      }

      // Replay URL + scroll
      if (state.url) {
        socket.emit("sync-event", { type: "navigate", url: state.url });
      }
      if (typeof state.scrollX === "number") {
        socket.emit("sync-event", {
          type: "v-scroll",
          x: state.scrollX,
          y: state.scrollY
        });
      }
    }
  });

  socket.on("permission-granted", ({ leadId }) => {
    leadId = String(leadId);
    const state = leadState.get(leadId);
    if (!state) return;

    state.permission = true;

    socket.to(room(leadId)).emit("permission-status", { granted: true });
  });

  socket.on("sync-event", (data) => {
    const leadId = socket.data.leadId;
    if (!leadId) return;

    const state = leadState.get(leadId);
    if (!state) return;

    if (data.type === "navigate") {
      state.url = data.url;
    }

    if (data.type === "v-scroll") {
      state.scrollX = data.x;
      state.scrollY = data.y;
    }

    socket.to(room(leadId)).emit("sync-event", data);
  });

  socket.on("disconnect", () => {
    const { leadId, role } = socket.data;
    if (!leadId) return;

    if (role === "visitor") {
      visitorSocketByLead.delete(leadId);
      socket.to(room(leadId)).emit("presence", { visitor: "offline" });
    }

    if (role === "admin") {
      const set = adminSocketsByLead.get(leadId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) adminSocketsByLead.delete(leadId);
      }
    }
  });
});

server.listen(process.env.PORT || 3000, () =>
  console.log("Cobrowse server live")
);
