/**
 * Client for the watcher server's HTTP API.
 *
 * Uses Obsidian's `requestUrl`, which works on desktop and mobile and is not
 * subject to the browser's cross-origin rules.
 */

import { requestUrl } from "obsidian";

import type {
  ApiErrorBody,
  ApprovalList,
  ApprovalRequest,
  ApproveBody,
  ChatSession,
  ChatSessionList,
  PendingChangeList,
  ServerSettings,
  SessionMessageBody,
  StartSessionBody,
} from "./shared/types";

/** An error answer from the server, or a failure to reach it. */
export class WatcherError extends Error {
  constructor(
    /** HTTP status, or 0 when the server could not be reached. */
    readonly status: number,
    /** The server's error code, such as "note_changed". */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Connection {
  serverUrl: string;
  apiKey: string;
}

export class WatcherClient {
  constructor(private readonly connection: () => Connection) {}

  /** True once a server address and key are filled in. */
  get configured(): boolean {
    const { serverUrl, apiKey } = this.connection();
    return serverUrl.trim() !== "" && apiKey.trim() !== "";
  }

  health(): Promise<{ status: string }> {
    return this.call("GET", "/health");
  }

  /** The server's settings, or undefined for a server too old to report them. */
  async serverSettings(): Promise<ServerSettings | undefined> {
    try {
      return await this.call<ServerSettings>("GET", "/settings");
    } catch (error) {
      if (error instanceof WatcherError && error.status === 404) return undefined;
      throw error;
    }
  }

  async pendingApprovals(): Promise<ApprovalRequest[]> {
    const list = await this.call<ApprovalList>("GET", "/approvals?status=pending");
    return list.approvals;
  }

  approve(id: string, body: ApproveBody): Promise<ApprovalRequest> {
    return this.call("POST", `/approvals/${encodeURIComponent(id)}/approve`, body);
  }

  reject(id: string): Promise<ApprovalRequest> {
    return this.call("POST", `/approvals/${encodeURIComponent(id)}/reject`, {});
  }

  startSession(body: StartSessionBody): Promise<ChatSession> {
    return this.call("POST", "/sessions", body);
  }

  async sessions(): Promise<ChatSession[]> {
    const list = await this.call<ChatSessionList>("GET", "/sessions");
    return list.sessions;
  }

  session(id: string): Promise<ChatSession> {
    return this.call("GET", `/sessions/${encodeURIComponent(id)}`);
  }

  sendMessage(id: string, body: SessionMessageBody): Promise<ChatSession> {
    return this.call("POST", `/sessions/${encodeURIComponent(id)}/messages`, body);
  }

  async pendingChanges(): Promise<PendingChangeList["changes"]> {
    const list = await this.call<PendingChangeList>("GET", "/changes");
    return list.changes;
  }

  rejectChange(id: string): Promise<{ id: string; status: "rejected" }> {
    return this.call("POST", `/changes/${encodeURIComponent(id)}/reject`, {});
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const { serverUrl, apiKey } = this.connection();
    if (!this.configured) {
      throw new WatcherError(0, "not_configured", "Set the server address and API key first");
    }
    let response;
    try {
      response = await requestUrl({
        url: serverUrl.trim().replace(/\/+$/, "") + path,
        method,
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        contentType: body === undefined ? undefined : "application/json",
        body: body === undefined ? undefined : JSON.stringify(body),
        throw: false,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new WatcherError(0, "unreachable", `Could not reach the watcher server: ${reason}`);
    }
    let json: unknown;
    try {
      json = response.json;
    } catch {
      json = undefined;
    }
    if (response.status >= 400) {
      const error = json as Partial<ApiErrorBody> | undefined;
      throw new WatcherError(
        response.status,
        error?.error ?? "http_error",
        error?.message ?? `The server answered ${response.status}`,
      );
    }
    return json as T;
  }
}
