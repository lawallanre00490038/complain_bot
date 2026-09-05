import { Server } from 'http';
import { WebSocketServer } from 'ws';

type RealtimeEvent = {
  type: string;
  ticketId?: string;
  threadId?: string;
  phone?: string;
  message?: string;
  payload?: any;
};

let wss: WebSocketServer | null = null;

export function setupRealtimeHub(server: Server) {
  if (wss) return wss;

  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  });

  return wss;
}

export function broadcastRealtimeEvent(event: RealtimeEvent) {
  if (!wss) return;
  const message = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

export function broadcastEscalationMessage(params: { ticketId: string; threadId?: string; phone?: string; direction: 'inbound' | 'outbound'; message: string }) {
  broadcastRealtimeEvent({
    type: 'escalation-message',
    ticketId: params.ticketId,
    threadId: params.threadId,
    phone: params.phone,
    message: params.message,
    payload: { direction: params.direction },
  });
}
