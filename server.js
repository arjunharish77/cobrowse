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

// leadId -> socketId (visitor)
const visitorByLead = new Map();
// leadId -> Set(socketId) (admins)
const adminsByLead = new Map();
// leadId -> { permission, url, sx, sy }
const leadState = new Map();

const room = (leadId) => `room-${leadId}`;

function getState(leadId) {
  if (!leadState.has(leadId)) leadState.set(leadId, { permission: false });
  return leadState.get(leadId);
}

// API to trigger visitor permission prompt
app.post("/request-access", (req, res) => {
  const leadId = String(req.body?.leadId || "");
  const vSocket = visitorByLead.get(leadId);

  if (!vSocket) return res.status(404).json({ error: "Visitor offline" });

  io.to(vSocket).emit("request-permission");
  return res.json({
    success: true,
    adminUrl: `http://127.0.0.1:5500/admin.html?leadId=${encodeURIComponent(leadId)}`
  });
});

io.on("connection", (socket) => {
  socket.data = { role: null, leadId: null };

  socket.on("identify", ({ leadId, role }) => {
    leadId = String(leadId);
    socket.data.leadId = leadId;
    socket.data.role = role;

    socket.join(room(leadId));
    const st = getState(leadId);

    if (role === "visitor") {
      visitorByLead.set(leadId, socket.id);
      socket.to(room(leadId)).emit("presence", { visitor: "online" });
      return;
    }

    if (role === "admin") {
      if (!adminsByLead.has(leadId)) adminsByLead.set(leadId, new Set());
      adminsByLead.get(leadId).add(socket.id);

      // Replay known state to admin
      if (visitorByLead.has(leadId)) socket.emit("presence", { visitor: "online" });
      if (st.permission) socket.emit("permission-status", { granted: true });
      if (st.url) socket.emit("sync-event", { type: "navigate", url: st.url });
      if (typeof st.sx === "number" && typeof st.sy === "number") {
        socket.emit("sync-event", { type: "v-scroll", x: st.sx, y: st.sy });
      }
    }
  });

  socket.on("permission-granted", ({ leadId }) => {
    leadId = String(leadId);
    const st = getState(leadId);
    st.permission = true;
    socket.to(room(leadId)).emit("permission-status", { granted: true });
  });

  socket.on("sync-event", (data) => {
    const leadId = socket.data.leadId;
    if (!leadId) return;

    const st = getState(leadId);

    // Gate visitor events until permission is granted
    if (socket.data.role === "visitor" && !st.permission) return;

    // Cache navigations + visitor scroll for replay
    if (data?.type === "navigate") st.url = data.url;
    if (data?.type === "v-scroll") { st.sx = data.x; st.sy = data.y; }

    socket.to(room(leadId)).emit("sync-event", data);
  });

  socket.on("disconnect", () => {
    const { leadId, role } = socket.data;
    if (!leadId) return;

    if (role === "visitor") {
      if (visitorByLead.get(leadId) === socket.id) visitorByLead.delete(leadId);
      socket.to(room(leadId)).emit("presence", { visitor: "offline" });
    }

    if (role === "admin") {
      const set = adminsByLead.get(leadId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) adminsByLead.delete(leadId);
      }
    }
  });
});

server.listen(process.env.PORT || 3000, () => console.log("Cobrowse server running"));
