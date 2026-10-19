
import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { setupChat } from "./chat.js";

const app = express();
const server = createServer(app);
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    name: "Nakama Chat API",
    status: "running",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    websocket: "/ws",
  });
});

setupChat(server);

server.listen(PORT, () => {
  console.log(`HTTP:      http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
});
