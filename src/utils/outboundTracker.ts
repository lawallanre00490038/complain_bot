// Simple process-lifetime tracker for last outbound message type per phone
export const lastOutboundType = new Map<string, string>();

export function setLastOutbound(phone: string, type: string) {
  lastOutboundType.set(String(phone), type);
}

export function getLastOutbound(phone: string) {
  return lastOutboundType.get(String(phone));
}
