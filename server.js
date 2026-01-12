const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' })); // Increased for high-fidelity HTML

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 2e7 // 20MB limit
});

const activeLeads = new Map();

app.post("/request-access", (req, res) => {
    const { leadId } = req.body;
    const socketId = activeLeads.get(leadId);
    if (socketId) {
        io.to(socketId).emit("request-permission");
        return res.json({ success: true, adminUrl: `http://localhost:8080/admin.html?leadId=${leadId}` });
    }
    res.status(404).json({ error: "Lead offline" });
});

io.on("connection", (socket) => {
    socket.on("identify", (data) => {
        socket.leadId = data.leadId;
        socket.join(`room-${data.leadId}`);
        if (data.role === "visitor") activeLeads.set(data.leadId, socket.id);
    });

    socket.on("sync-event", (data) => {
        socket.to(`room-${socket.leadId}`).emit("sync-event", data);
    });

    socket.on("disconnect", () => {
        if (socket.leadId) activeLeads.delete(socket.leadId);
    });
});

server.listen(process.env.PORT || 3000, () => console.log("Server Live"));
