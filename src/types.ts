export type PinStatus = "open" | "resolved";

export interface DiagnosticEvent {
  kind: "console.error" | "network.error" | "window.error";
  timestamp: string;
  message: string;
  status?: number;
  url?: string;
}

export interface PinDiagnostics {
  viewportWidth: number;
  viewportHeight: number;
  userAgent: string;
  events: DiagnosticEvent[];
}

export interface PinReply {
  id: number;
  pinId: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface Pin {
  id: number;
  pagePath: string;
  selector: string;
  anchorText: string;
  xPercent: number;
  yPercent: number;
  author: string;
  body: string;
  status: PinStatus;
  diagnostics: PinDiagnostics;
  githubUrl: string | null;
  createdAt: string;
  replies: PinReply[];
}

export interface CreatePinInput {
  pagePath: string;
  selector: string;
  anchorText?: string;
  xPercent: number;
  yPercent: number;
  author?: string;
  body: string;
  diagnostics?: Partial<PinDiagnostics>;
}

export interface GitHubTarget {
  owner: string;
  repo: string;
  issueNumber?: number;
}

export interface StagepinServerOptions {
  upstreamUrl: string;
  host?: string;
  port?: number;
  dbPath?: string;
  password?: string;
  githubTarget?: string;
  githubToken?: string;
}
