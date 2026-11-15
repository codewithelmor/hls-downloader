import {
  createSlice,
  PayloadAction,
  Slice,
  CaseReducer,
} from "@reduxjs/toolkit";
import type {
  PlayerCaptureSourceSummary,
  PlayerCaptureUpdate,
} from "../../services/player-capture";

export type PlayerCaptureStatus =
  | "starting"
  | "waiting"
  | "capturing"
  | "protected"
  | "unsupported"
  | "saving"
  | "error";

export interface PlayerCaptureSession {
  tabId: number;
  status: PlayerCaptureStatus;
  startedAt: number;
  pageUrl?: string;
  title?: string;
  sources: PlayerCaptureSourceSummary[];
  message?: string;
}

export interface IPlayerCaptureState {
  sessions: Record<string, PlayerCaptureSession | null>;
}

export interface IPlayerCaptureTabPayload {
  tabId: number;
}
export interface IPlayerCaptureStartedPayload {
  tabId: number;
  pageUrl?: string;
  title?: string;
}
export interface IPlayerCaptureUpdatePayload extends PlayerCaptureUpdate {
  tabId: number;
}
export interface IPlayerCaptureFailedPayload {
  tabId: number;
  message: string;
}
export interface IPlayerCaptureFinishedPayload {
  tabId: number;
  jobIds: string[];
}

interface IPlayerCaptureReducers {
  start: CaseReducer<
    IPlayerCaptureState,
    PayloadAction<IPlayerCaptureTabPayload>
  >;
  started: CaseReducer<
    IPlayerCaptureState,
    PayloadAction<IPlayerCaptureStartedPayload>
  >;
  update: CaseReducer<
    IPlayerCaptureState,
    PayloadAction<IPlayerCaptureUpdatePayload>
  >;
  finish: CaseReducer<
    IPlayerCaptureState,
    PayloadAction<IPlayerCaptureTabPayload>
  >;
  finished: CaseReducer<
    IPlayerCaptureState,
    PayloadAction<IPlayerCaptureFinishedPayload>
  >;
  cancel: CaseReducer<
    IPlayerCaptureState,
    PayloadAction<IPlayerCaptureTabPayload>
  >;
  cancelled: CaseReducer<
    IPlayerCaptureState,
    PayloadAction<IPlayerCaptureTabPayload>
  >;
  failed: CaseReducer<
    IPlayerCaptureState,
    PayloadAction<IPlayerCaptureFailedPayload>
  >;
  [key: string]: CaseReducer<IPlayerCaptureState, PayloadAction<any>>;
}

const initialPlayerCaptureState: IPlayerCaptureState = { sessions: {} };

// Statuses after which the capture no longer receives media.
const STOPPED = new Set<PlayerCaptureStatus>([
  "protected",
  "saving",
  "error",
]);

export const playerCaptureSlice: Slice<
  IPlayerCaptureState,
  IPlayerCaptureReducers,
  "playerCapture"
> = createSlice({
  name: "playerCapture",
  initialState: initialPlayerCaptureState,
  reducers: {
    start(state, action: PayloadAction<IPlayerCaptureTabPayload>) {
      const { tabId } = action.payload;
      const current = state.sessions[tabId];
      if (current && !STOPPED.has(current.status)) return;
      state.sessions[tabId] = {
        tabId,
        status: "starting",
        startedAt: Date.now(),
        sources: [],
      };
    },
    started(state, action: PayloadAction<IPlayerCaptureStartedPayload>) {
      const { tabId, pageUrl, title } = action.payload;
      const session = state.sessions[tabId];
      if (!session) return;
      session.pageUrl = pageUrl;
      session.title = title;
      if (session.status === "starting") session.status = "waiting";
    },
    update(state, action: PayloadAction<IPlayerCaptureUpdatePayload>) {
      const { tabId, status, sources, message } = action.payload;
      const session = state.sessions[tabId];
      if (!session || STOPPED.has(session.status)) return;
      if (sources) session.sources = sources;
      if (status) session.status = status;
      if (message !== undefined) session.message = message;
    },
    finish(state, action: PayloadAction<IPlayerCaptureTabPayload>) {
      const session = state.sessions[action.payload.tabId];
      if (!session || session.status === "saving") return;
      session.status = "saving";
      session.message = undefined;
    },
    finished(state, action: PayloadAction<IPlayerCaptureFinishedPayload>) {
      delete state.sessions[action.payload.tabId];
    },
    cancel(_state, _action: PayloadAction<IPlayerCaptureTabPayload>) {},
    cancelled(state, action: PayloadAction<IPlayerCaptureTabPayload>) {
      delete state.sessions[action.payload.tabId];
    },
    failed(state, action: PayloadAction<IPlayerCaptureFailedPayload>) {
      const { tabId, message } = action.payload;
      const session =
        state.sessions[tabId] ??
        (state.sessions[tabId] = {
          tabId,
          status: "error",
          startedAt: Date.now(),
          sources: [],
        });
      session.status = "error";
      session.message = message;
    },
  },
});
