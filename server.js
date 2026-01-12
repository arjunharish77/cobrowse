// server.js (Railway)
"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 2e7, // keep if you ever enable snapshot mode
});

const leadToVisitorSocket = new Map(); // leadId -> socketId
const leadToAdminSockets = new Map(); // leadId -> Set(socketId)
const leadState = new Map(); // leadId -> { url, scrollXRatio, scrollYRatio, lastSeen }

function getRoom(leadId) {
  return `room-${leadId}`;
}

function ensureAdminSet(leadId) {
  if (!leadToAdminSockets.has(leadId)) {
    leadToAdminSockets.set(leadId, new Set());
  }
  return leadToAdminSockets.get(leadId);
}

// Optional: allowlist origins you will mirror (recommended for enterprise)
const ALLOWED_ORIGINS = [
  // "https://yourdomain.com",
  // "https://www.yourdomain.com",
];

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    if (ALLOWED_ORIGINS.length === 0) return true; // allow all if not set
    return ALLOWED_ORIGINS.includes(u.origin);
  } catch {
    return false;
  }
}

// Admin triggers permission popup on visitor
app.post("/request-access", (req, res) => {
  const { leadId } = req.body || {};
  if (!leadId) return res.status(400).json({ error: "leadId is required" });

  const visitorSocketId = leadToVisitorSocket.get(leadId);
  if (!visitorSocketId) return res.status(404).json({ error: "Lead offline" });

  io.to(visitorSocketId).emit("request-permission", { leadId });

  // For your local admin console
  return res.json({
    success: true,
    adminUrl: `http://localhost:8080/admin.html?leadId=${encodeURIComponent(leadId)}`
  });
});

io.on("connection", (socket) => {
  socket.data = { role: null, leadId: null, granted: false };

  socket.on("identify", ({ leadId, role }) => {
    if (!leadId || !role) return;
    socket.data.leadId = String(leadId);
    socket.data.role = role;

    socket.join(getRoom(socket.data.leadId));

    if (role === "visitor") {
      leadToVisitorSocket.set(socket.data.leadId, socket.id);
      socket.data.granted = false; // permission not granted yet by default

      // tell admins visitor is online
      socket.to(getRoom(socket.data.leadId)).emit("presence", { leadId: socket.data.leadId, visitor: "online" });
    }

    if (role === "admin") {
      const set = ensureAdminSet(socket.data.leadId);
      set.add(socket.id);

      // if we have cached state, push it immediately
      const st = leadState.get(socket.data.leadId);
      if (st?.url) {
        socket.emit("sync-event", { type: "navigate", url: st.url, from: "server" });
      }
      if (typeof st?.scrollXRatio === "number" && typeof st?.scrollYRatio === "number") {
        socket.emit("sync-event", { type: "v-scroll", x: st.scrollXRatio, y: st.scrollYRatio, from: "server" });
      }

      // ask visitor to emit current URL + scroll (if any)
      socket.to(getRoom(socket.data.leadId)).emit("request-state", { leadId: socket.data.leadId });
    }
  });

  // Visitor grants permission
  socket.on("permission-granted", ({ leadId }) => {
    if (!leadId) return;
    if (socket.data.role !== "visitor") return;
    if (String(leadId) !== socket.data.leadId) return;

    socket.data.granted = true;
    socket.to(getRoom(socket.data.leadId)).emit("permission-status", { leadId: socket.data.leadId, granted: true });
  });

  // Keep a heartbeat to mark active
  socket.on("heartbeat", ({ leadId, role }) => {
    const id = String(leadId || socket.data.leadId || "");
    if (!id) return;
    const st = leadState.get(id) || {};
    st.lastSeen = Date.now();
    leadState.set(id, st);
  });

  socket.on("sync-event", (data) => {
    const leadId = socket.data.leadId;
    if (!leadId) return;

    // Only allow visitor to broadcast *after permission granted*
    if (socket.data.role === "visitor" && !socket.data.granted) {
      // Allow only minimal state updates before permission if you want
      if (data?.type !== "navigate") return;
    }

    // Validate navigate URLs (optional but recommended)
    if (data?.type === "navigate") {
      if (!data.url || !isAllowedUrl(data.url)) return;

      const st = leadState.get(leadId) || {};
      st.url = data.url;
      st.lastSeen = Date.now();
      leadState.set(leadId, st);
    }

    if (data?.type === "v-scroll") {
      const st = leadState.get(leadId) || {};
      st.scrollXRatio = data.x;
      st.scrollYRatio = data.y;
      st.lastSeen = Date.now();
      leadState.set(leadId, st);
    }

    // Broadcast to everyone else in room
    socket.to(getRoom(leadId)).emit("sync-event", data);
  });

  socket.on("disconnect", () => {
    const leadId = socket.data.leadId;
    const role = socket.data.role;

    if (leadId && role === "visitor") {
      // only delete mapping if it matches this socket
      const mapped = leadToVisitorSocket.get(leadId);
      if (mapped === socket.id) {
        leadToVisitorSocket.delete(leadId);
        socket.to(getRoom(leadId)).emit("presence", { leadId, visitor: "offline" });
      }
    }

    if (leadId && role === "admin") {
      const set = leadToAdminSockets.get(leadId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) leadToAdminSockets.delete(leadId);
      }
    }
  });
});

server.listen(process.env.PORT || 3000, () => console.log("Server Live"));
