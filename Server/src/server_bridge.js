// node v18+
// npm i ws dotenv
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const PORT = Number(process.env.PORT || 8091);
const XI = "sk_20aad4619f7b7241fd4e696fe1eb6d1765b3aafc708368cb" || "";
const AGENT_ID = "agent_3401kakdn35wenjb3c23479grfw3" || "";
const WAIT_SEC = Number(process.env.WAIT_SEC ?? 0);        // 0 => idle close disabled
const SAVE_OUT = String(process.env.SAVE_OUT || "false") === "true";

/* ---------- WAV/PCM helpers ---------- */
function pcm16ToWav(pcm, sampleRate = 16000, channels = 1) {
    const byteRate = sampleRate * channels * 2;
    const blockAlign = channels * 2;
    const dataSize = pcm.length;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcm]);
}

/* ---------- HTTP + WS server ---------- */
const server = http.createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
});

const wss = new WebSocketServer({ server, path: "/ws/app" });

wss.on("connection", (client, req) => {
    const urlObj = new URL(req.url, "http://localhost");
    const agentName = urlObj.searchParams.get("agent_name");
    const customerName = urlObj.searchParams.get("customer_name");
    const dueAmount = urlObj.searchParams.get("amount");
    const dueDate = urlObj.searchParams.get("due_date");

    console.log("🎯 Agent Name from UI =", agentName);
    console.log("🎯 customerName from UI =", customerName);
    console.log("🎯 dueAmount from UI =", dueAmount);
    console.log("🎯 dueDate from UI =", dueDate);
    console.log("🟢 Flutter connected:", req.socket.remoteAddress);

    // Per-connection state
    let closed = false;
    let idleTimer = null;
    let pingIv = null;
    const agentPcmChunks = [];

    // 🔹 NEW: queue until agent opens
    let agentOpen = false;
    const pending = []; // {data, isBinary}

    const bumpIdle = () => {
        if (WAIT_SEC <= 0) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finalize("idle-timeout", 1000), WAIT_SEC * 1000);
    };

    const finalize = (reason, code = 1000) => {
        if (closed) return;
        closed = true;

        clearTimeout(idleTimer);
        clearInterval(pingIv);

        if (SAVE_OUT && agentPcmChunks.length) {
            try {
                const pcm = Buffer.concat(agentPcmChunks);
                const outDir = path.join(process.cwd(), "audio");
                fs.mkdirSync(outDir, { recursive: true });
                const outFile = path.join(outDir, `agent_out_${Date.now()}.wav`);
                fs.writeFileSync(outFile, pcm16ToWav(pcm, 16000, 1));
                console.log("💾 Saved agent audio →", outFile);
            } catch (e) {
                console.error("Save error:", e);
            }
        }

        try { if (client.readyState === WebSocket.OPEN) client.close(code, reason); } catch { }
        try { if (agent.readyState === WebSocket.OPEN) agent.close(code, reason); } catch { }
        console.log("🔻 closed:", reason, code);
    };

    // --- Heartbeat (server → browser) ---
    client.isAlive = true;
    client.on("pong", () => { client.isAlive = true; });
    pingIv = setInterval(() => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (!client.isAlive) {
            console.warn("⚠️ no pong from client → terminating");
            return finalize("client-no-pong", 1001);
        }
        client.isAlive = false;
        try { client.ping(); } catch { }
    }, 15000);

    // --- Connect to ElevenLabs agent ---
    const agentUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}`;
    const agent = new WebSocket(agentUrl, { headers: { "xi-api-key": XI } });

    // helper: safe send to agent (queues if not open)
    function sendToAgent(data, isBinary) {
        if (!agentOpen) {
            if (pending.length < 1000) pending.push({ data, isBinary });
            return;
        }
        try {
            if (isBinary) {
                // raw PCM (16k/mono/16-bit) bytes from client
                const b64 = Buffer.from(data).toString("base64");
                agent.send(JSON.stringify({ user_audio_chunk: b64 }));
            } else {
                agent.send(typeof data === "string" ? data : data.toString());
            }
        } catch (e) {
            console.error("uplink err:", e);
        }
    }

    agent.on("open", () => {
        console.log("🤖 Agent WS open");
        agentOpen = true;

        // optional: notify client UI so it can enable mic
        try { client.send(JSON.stringify({ type: "agent_ready" })); } catch { }

        // init config
        agent.send(JSON.stringify({
            type: "conversation_initiation_client_data",
            conversation_initiation_client_data: {
                conversation_config_override: {
                    conversation: {
                        text_only: false,
                        agent_output_audio_format: "pcm_16000",
                        user_input_audio_format: "pcm_16000",
                        model_id: "eleven_multilingual_v2",
                        agent: {
                            voice: { voice_id: "6pVydnYcVtMsrrSeUKs6" }
                        }
                    }
                }
            },
            dynamic_variables: {
                agent_name: agentName,
                customer_name: customerName,
                due_amount: dueAmount,
                due_date: dueDate
            }
        }));


        // flush queued messages
        if (pending.length) {
            for (const { data, isBinary } of pending) sendToAgent(data, isBinary);
            pending.length = 0;
        }
        bumpIdle();
    });

    // Client (Flutter) → Agent
    client.on("message", (data, isBinary) => {
        sendToAgent(data, isBinary);   // ✅ guarded/queued
        bumpIdle();
    });

    client.on("close", (code, reasonBuf) => {
        const reason = reasonBuf?.toString?.() || "";
        console.log("client closed:", code, reason);
        finalize(`client-close(${code})`, code || 1000);
    });

    client.on("error", (e) => {
        console.error("client err:", e);
        finalize("client-error", 1011);
    });

    // Agent → Client (Flutter)
    agent.on("message", (buf) => {
        let json;
        try { json = JSON.parse(buf.toString()); } catch { }

        if (json?.type === "audio") {
            const b64 = json.audio_event?.audio_base_64;
            if (b64) agentPcmChunks.push(Buffer.from(b64, "base64"));
            bumpIdle();
        } else if (json?.type === "ping") {
            agent.send(JSON.stringify({ type: "pong", event_id: json.ping_event?.event_id }));
        } else {
            bumpIdle();
        }

        try {
            if (client.readyState === WebSocket.OPEN) client.send(buf.toString());
        } catch { }
    });

    agent.on("close", (code, reasonBuf) => {
        agentOpen = false;
        const reason = reasonBuf?.toString?.() || "";
        console.log("agent closed:", code, reason);
        finalize(`agent-close(${code})`, code || 1000);
    });

    agent.on("error", (e) => {
        agentOpen = false;
        console.error("agent err:", e);
        finalize("agent-error", 1011);
    });
});

// / OLD
// server.listen(PORT, () => {
//   console.log(`🚀 Server running on http://localhost:${PORT}`);
//   console.log(`🔗 WS path ws://localhost:${PORT}/ws/app`);
// });

// NEW
const HOST = "0.0.0.0";
const port = "8090";
server.listen(PORT, HOST, () => {
    console.log(`🚀 Server running on http://${HOST}:${PORT}`);
    console.log(`🔗 WS path ws://${HOST}:${PORT}/ws/app`);
});

// graceful shutdown
process.on("SIGINT", () => { console.log("SIGINT"); server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { console.log("SIGTERM"); server.close(() => process.exit(0)); });
