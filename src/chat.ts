
import type { Server } from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type {
  ClientEvent,
  Peer,
  PeerSignal,
  ServerEvent,
} from "./protocol.js";

type Client = {
  socket: WebSocket;
  username: string;
  roomId: string;
  peerId: string;
};

type Room = {
  id: string;
  name: string;
  password?: string;
  creatorSocket?: WebSocket;
};

const MAX_PASSWORD_LENGTH = 128;
const clients = new Map<WebSocket, Client>();
const rooms = new Map<string, Room>();

function send(socket: WebSocket, event: ServerEvent) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

function roomUsers(room: string): string[] {
  return [
    ...new Set(
      [...clients.values()]
        .filter((client) => client.roomId === room)
        .map((client) => client.username),
    ),
  ].sort();
}

function publishUsers(room: string) {
  const users = roomUsers(room);
  for (const [socket, client] of clients) {
    if (client.roomId === room) send(socket, { type: "USERS", room, users });
  }
}

function publishPeers(room: string) {
  const roomClients = [...clients.values()].filter(
    (client) => client.roomId === room,
  );
  for (const client of roomClients) {
    const peers: Peer[] = roomClients
      .filter((peer) => peer.socket !== client.socket)
      .map((peer) => ({ id: peer.peerId, username: peer.username }));
    send(client.socket, { type: "PEERS", peers });
  }
}

function leaveRoom(socket: WebSocket) {
  const client = clients.get(socket);
  if (!client) return;

  const room = rooms.get(client.roomId);
  if (room?.creatorSocket === socket) {
    closeRoom(room);
    return;
  }

  clients.delete(socket);
  if (!room) return;
  publishUsers(room.id);
  publishPeers(room.id);
}

function closeRoom(room: Room) {
  rooms.delete(room.id);

  for (const [socket, client] of clients) {
    if (client.roomId !== room.id) continue;
    clients.delete(socket);
    send(socket, {
      type: "ROOM_CLOSED",
      roomId: room.id,
      roomName: room.name,
    });
  }
}

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9_-]{1,24}$/.test(value)
  );
}

function validPeerId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function parsePeerSignal(value: unknown): PeerSignal | null {
  if (!value || typeof value !== "object") return null;
  const signal = value as Record<string, unknown>;

  if (
    signal.type === "description" &&
    signal.description &&
    typeof signal.description === "object"
  ) {
    const description = signal.description as Record<string, unknown>;
    if (
      (description.type === "offer" || description.type === "answer") &&
      typeof description.sdp === "string" &&
      description.sdp.length > 0 &&
      description.sdp.length <= 12_000
    ) {
      return {
        type: "description",
        description: { type: description.type, sdp: description.sdp },
      };
    }
  }

  if (
    signal.type === "candidate" &&
    signal.candidate &&
    typeof signal.candidate === "object"
  ) {
    const candidate = signal.candidate as Record<string, unknown>;
    if (
      typeof candidate.candidate === "string" &&
      candidate.candidate.length > 0 &&
      candidate.candidate.length <= 4_096 &&
      (candidate.sdpMid === undefined ||
        candidate.sdpMid === null ||
        (typeof candidate.sdpMid === "string" &&
          candidate.sdpMid.length <= 256)) &&
      (candidate.sdpMLineIndex === undefined ||
        candidate.sdpMLineIndex === null ||
        (typeof candidate.sdpMLineIndex === "number" &&
          Number.isInteger(candidate.sdpMLineIndex) &&
          candidate.sdpMLineIndex >= 0 &&
          candidate.sdpMLineIndex <= 65_535)) &&
      (candidate.usernameFragment === undefined ||
        (typeof candidate.usernameFragment === "string" &&
          candidate.usernameFragment.length <= 256))
    ) {
      return {
        type: "candidate",
        candidate: {
          candidate: candidate.candidate,
          ...(candidate.sdpMid !== undefined
            ? { sdpMid: candidate.sdpMid as string | null }
            : {}),
          ...(candidate.sdpMLineIndex !== undefined
            ? { sdpMLineIndex: candidate.sdpMLineIndex as number | null }
            : {}),
          ...(typeof candidate.usernameFragment === "string"
            ? { usernameFragment: candidate.usernameFragment }
            : {}),
        },
      };
    }
  }

  return null;
}

function loadConfiguredRooms(): Room[] {
  const configured = process.env.CHAT_PRIVATE_ROOMS;
  if (!configured) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    throw new Error("CHAT_PRIVATE_ROOMS must be a JSON object of room names to passwords");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CHAT_PRIVATE_ROOMS must be a JSON object of room names to passwords");
  }

  const configuredRooms: Room[] = [];
  for (const [room, password] of Object.entries(parsed)) {
    if (
      !validName(room) ||
      typeof password !== "string" ||
      password.length === 0 ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new Error(
        `Invalid private room configuration for "${room}"; use valid room names and passwords of 1-${MAX_PASSWORD_LENGTH} characters`,
      );
    }
    configuredRooms.push({ id: room, name: room, password });
  }
  return configuredRooms;
}

function parseEvent(raw: Buffer): ClientEvent | null {
  try {
    const value: unknown = JSON.parse(raw.toString());

    if (!value || typeof value !== "object") return null;

    const event = value as Record<string, unknown>;

    if (
      event.type === "CREATE_ROOM" &&
      validName(event.username) &&
      typeof event.name === "string" &&
      event.name.trim().length > 0 &&
      event.name.trim().length <= 40 &&
      !/[\u0000-\u001f\u007f]/.test(event.name) &&
      (event.password === undefined ||
        (typeof event.password === "string" &&
          event.password.length > 0 &&
          event.password.length <= MAX_PASSWORD_LENGTH)) &&
      (event.peerId === undefined || validPeerId(event.peerId))
    ) {
      return {
        type: "CREATE_ROOM",
        username: event.username,
        name: event.name.trim(),
        ...(typeof event.password === "string" ? { password: event.password } : {}),
        ...(typeof event.peerId === "string" ? { peerId: event.peerId } : {}),
      };
    }

    if (
      event.type === "JOIN" &&
      validName(event.username) &&
      typeof event.roomId === "string" &&
      /^[a-zA-Z0-9_-]{1,40}$/.test(event.roomId) &&
      (event.password === undefined ||
        (typeof event.password === "string" &&
          event.password.length > 0 &&
          event.password.length <= MAX_PASSWORD_LENGTH)) &&
      (event.peerId === undefined || validPeerId(event.peerId))
    ) {
      return {
        type: "JOIN",
        username: event.username,
        roomId: event.roomId,
        ...(typeof event.password === "string" ? { password: event.password } : {}),
        ...(typeof event.peerId === "string" ? { peerId: event.peerId } : {}),
      };
    }

    if (event.type === "SIGNAL" && validPeerId(event.peerId)) {
      const signal = parsePeerSignal(event.signal);
      if (signal) return { type: "SIGNAL", peerId: event.peerId, signal };
    }

    return null;
  } catch {
    return null;
  }
}

export function setupChat(server: Server) {
  for (const room of loadConfiguredRooms()) rooms.set(room.id, room);
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 16 * 1024,
  });

  wss.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary || !Buffer.isBuffer(data)) {
        send(socket, {
          type: "ERROR",
          message: "Only text messages are supported",
        });
        return;
      }

      const event = parseEvent(data);

      if (!event) {
        send(socket, {
          type: "ERROR",
          message: "Invalid event or username/room",
        });
        return;
      }

      if (event.type === "CREATE_ROOM") {
        const roomId = createRoomId();
        const room: Room = {
          id: roomId,
          name: event.name,
          creatorSocket: socket,
          ...(event.password ? { password: event.password } : {}),
        };
        rooms.set(roomId, room);
        joinRoom(socket, event.username, room, event.peerId);
        return;
      }

      if (event.type === "JOIN") {
        const room = rooms.get(event.roomId);
        if (!room) {
          send(socket, {
            type: "ERROR",
            message: `No room found with ID "${event.roomId}"`,
          });
          return;
        }

        if (room.password !== undefined && event.password !== room.password) {
          send(socket, {
            type: "PASSWORD_REQUIRED",
            roomId: room.id,
            roomName: room.name,
            retry: event.password !== undefined,
          });
          return;
        }
        joinRoom(socket, event.username, room, event.peerId);
        return;
      }

      if (event.type === "SIGNAL") {
        const client = clients.get(socket);
        if (!client) {
          send(socket, { type: "ERROR", message: "Join a room before connecting to peers" });
          return;
        }
        const target = [...clients.values()].find(
          (peer) =>
            peer.roomId === client.roomId && peer.peerId === event.peerId,
        );
        if (!target) {
          send(socket, { type: "ERROR", message: "That peer is no longer in the room" });
          return;
        }
        send(target.socket, {
          type: "SIGNAL",
          fromId: client.peerId,
          fromName: client.username,
          signal: event.signal,
        });
      }
    });

    socket.on("close", () => {
      leaveRoom(socket);
    });

    socket.on("error", (error) => {
      console.error("WebSocket error:", error.message);
    });
  });

  return wss;
}

function createRoomId() {
  let roomId: string;
  do {
    roomId = randomInt(1_000_000).toString().padStart(6, "0");
  } while (rooms.has(roomId));
  return roomId;
}

function joinRoom(
  socket: WebSocket,
  username: string,
  room: Room,
  requestedPeerId?: string,
) {
  const peerId = requestedPeerId ?? randomUUID();
  if (
    [...clients.values()].some(
      (client) => client.roomId === room.id && client.peerId === peerId &&
        client.socket !== socket,
    )
  ) {
    send(socket, { type: "ERROR", message: "That peer ID is already in use" });
    return;
  }
  const previous = clients.get(socket);
  if (previous) leaveRoom(socket);

  clients.set(socket, { socket, username, roomId: room.id, peerId });
  send(socket, {
    type: "WELCOME",
    username,
    roomId: room.id,
    roomName: room.name,
    visibility: room.password === undefined ? "public" : "private",
  });
  publishUsers(room.id);
  publishPeers(room.id);
}
