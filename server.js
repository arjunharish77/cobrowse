const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Map to track which lead is on which socket
const activeLeads = new Map();

// 1. CRM API Endpoint: Triggered by your CRM
app.post("/request-access", (req, res) => {
    const { leadId } = req.body;
    const socketId = activeLeads.get(leadId);

    if (socketId) {
        // Send request ONLY to this specific lead
        io.to(socketId).emit("request-permission");
        return res.json({ 
            success: true, 
            adminUrl: `http://localhost:8080/admin.html?leadId=${leadId}` 
        });
    }
    res.status(404).json({ error: "Lead is currently offline" });
});

io.on("connection", (socket) => {
    // 2. Identification
    socket.on("identify", (data) => {
        const { leadId, role } = data;
        socket.leadId = leadId;
        socket.join(`room-${leadId}`);

        if (role === "visitor") {
            activeLeads.set(leadId, socket.id);
            console.log(`Lead ${leadId} is online.`);
        }
    });

    // 3. Bidirectional Syncing
    socket.on("sync-event", (data) => {
        // socket.to(...) sends to everyone in the room EXCEPT the sender
        // This is what prevents the "mirroring/loopback" bug
        socket.to(`room-${socket.leadId}`).emit("sync-event", data);
    });

    socket.on("disconnect", () => {
        if (socket.leadId) {
            activeLeads.delete(socket.leadId);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));