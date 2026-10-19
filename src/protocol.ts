
export type ClientEvent =
  | {
      type: "CREATE_ROOM";
      username: string;
      name: string;
      password?: string;
      peerId?: string;
    }
  | {
      type: "JOIN";
      username: string;
      roomId: string;
      password?: string;
      peerId?: string;
    }
  | { type: "SIGNAL"; peerId: string; signal: PeerSignal };

export type PeerSignal =
  | {
      type: "description";
      description: { type: "offer" | "answer"; sdp: string };
    }
  | {
      type: "candidate";
      candidate: {
        candidate: string;
        sdpMid?: string | null;
        sdpMLineIndex?: number | null;
        usernameFragment?: string;
      };
    };

export type Peer = {
  id: string;
  username: string;
};

export type ServerEvent =
  | {
      type: "WELCOME";
      username: string;
      roomId: string;
      roomName: string;
      visibility: "public" | "private";
    }
  | { type: "PASSWORD_REQUIRED"; roomId: string; roomName: string; retry: boolean }
  | { type: "ROOM_CLOSED"; roomId: string; roomName: string }
  | { type: "USERS"; users: string[]; room: string }
  | { type: "PEERS"; peers: Peer[] }
  | { type: "SIGNAL"; fromId: string; fromName: string; signal: PeerSignal }
  | { type: "ERROR"; message: string };
