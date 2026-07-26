export const BRIDGE_MAX_MESSAGE_SIZE = 1024 * 1024;

export interface BridgeRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface BridgeErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export type BridgeResponse =
  | { id: string | null; result: unknown }
  | { id: string | null; error: BridgeErrorPayload };

export interface BridgeCaller {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface DesktopCaptureAdapter {
  capture(filename: string): Promise<{
    data: Buffer;
    path: string;
  }>;
}
