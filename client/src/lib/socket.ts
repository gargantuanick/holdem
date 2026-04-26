import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@holdem/shared";
import { loadToken } from "./session";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";

let _socket: AppSocket | null = null;

export function getSocket(): AppSocket {
  if (_socket) return _socket;
  _socket = io(SERVER_URL, {
    autoConnect: true,
    transports: ["websocket", "polling"],
    withCredentials: true,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
    // Send the persisted session token on every (re)connect so the server
    // can re-authenticate the socket without waiting for the client to
    // explicitly call auth:resume. This closes the race where a socket
    // reconnect (network blip, server restart) leaves sock.data unauth'd
    // and table:join fails with "not authenticated".
    auth: (cb) => cb({ token: loadToken() ?? null }),
  });
  return _socket;
}

export function serverUrl(): string {
  return SERVER_URL;
}
