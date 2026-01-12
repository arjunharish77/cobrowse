"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---- STATE ----
const visitorByLead = new Map();   // leadId → socketId
const adminsByLead = new Map();    // leadId → Set(socketId)
const leadState = new Map();       // leadId → { url, sx, sy, permission }

const room = (leadId) => `room-${leadId}`;

function adminSet(leadId) {
  if (!adminsByLead.has(leadId)) adminsByLead.set(leadId, new Set());
  return adminsByLead.get(leadId);
}

// ---- API ----
app.post("/request-access", (req, res) => {
  const leadId = String(req.body.leadId || "");
  const visitorSocket = visitorByLead.get(leadId);

  if (!visitorSocket) {
    return res.status(404).json({ error: "Visitor offline" });
  }

  io.to(visitorSocket).emit("request-permission");

  return res.json({
    success: true,
    adminUrl: `http://127.0.0.1:5500/admin.html?leadId=${leadId}`
  });
});

// ---- SOCKET ----
io.on("connection", (socket) => {
  socket.data = { role: null, leadId: null };

  socket.on("identify", ({ leadId, role }) => {
    leadId = String(leadId);
    socket.data.leadId = leadId;
    socket.data.role = role;

    socket.join(room(leadId));
    if (!leadState.has(leadId)) leadState.set(leadId, { permission: false });

    if (role === "visitor") {
      visitorByLead.set(leadId, socket.id);
      socket.to(room(leadId)).emit("presence", { visitor: "online" });
    }

    if (role === "admin") {
      adminSet(leadId).add(socket.id);
      const state = leadState.get(leadId);

      if (visitorByLead.has(leadId)) {
        socket.emit("presence", { visitor: "online" });
      }
      if (state.permission) {
        socket.emit("permission-status", { granted: true });
      }
      if (state.url) {
        socket.emit("sync-event", { type: "navigate", url: state.url });
      }
      if (state.sx !== undefined) {
        socket.emit("sync-event", { type: "v-scroll", x: state.sx, y: state.sy });
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
    const state = leadState.get(leadId);
    if (!state) return;

    if (data.type === "navigate") state.url = data.url;
    if (data.type === "v-scroll") {
      state.sx = data.x;
      state.sy = data.y;
    }

    socket.to(room(leadId)).emit("sync-event", data);
  });

  socket.on("disconnect", () => {
    const { leadId, role } = socket.data;
    if (!leadId) return;

    if (role === "visitor") {
      visitorByLead.delete(leadId);
      socket.to(room(leadId)).emit("presence", { visitor: "offline" });
    }

    if (role === "admin") {
      const set = adminsByLead.get(leadId);
      if (set) {
        set.delete(socket.id);
        if (!set.size) adminsByLead.delete(leadId);
      }
    }
  });
});

server.listen(process.env.PORT || 3000, () =>
  console.log("Cobrowse server running")
);
