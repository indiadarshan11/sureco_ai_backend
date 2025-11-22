import "dotenv/config";
import app from "./app.js";
// Server/src/server.js
import http from "http";

import { attachAgentProxy } from "../ws/agentProxy.js";

const PORT = process.env.PORT || 8090;

const server = http.createServer(app);

// ✅ WebSocket proxy attach karo
attachAgentProxy(server);

// ✅ ab server start karo
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔗 WS proxy at ws://localhost:${PORT}/ws/agent`);
});

