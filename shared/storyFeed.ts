import type {
  RoleplaySession,
  RoleplayTurn,
  StoryMessage,
} from "./roleplay.js";

export interface StoryPreview {
  narration: string;
  dialogue: string;
}
export type StoryInferenceProgress =
  { type: "preview"; text: StoryPreview } | { type: "checking" };
export const STORY_PREVIEW_LIMIT = 12000;
export type StoryPhase =
  "history" | "generating" | "checking" | "retrying" | "unfinished";
export interface StoryProgress {
  turnId: string;
  attemptId: number;
  startedAt: number;
  phaseAt: number;
  phase: StoryPhase;
  preview?: StoryPreview;
  retry?: { kind: "format" | "provider"; count: number; max: number };
}

export interface StorySignal {
  instance: string;
  serial: number;
  version: number;
  memoryVersion: number;
  bookmarkVersion: number;
  progress?: StoryProgress;
}

export type StoryStatus = Pick<
  RoleplaySession,
  "id" | "title" | "revision" | "updatedAt"
> &
  Partial<Pick<RoleplaySession, "storyState" | "memory" | "turnId">> & {
    sourceAvailable?: boolean;
  };
export interface StoryDelta {
  status: StoryStatus;
  turn?: RoleplayTurn;
  items: StoryMessage[];
  more: boolean;
  reset?: boolean;
  earlier?: number;
  bookmarks?: string[];
}
export interface StoryBootstrap {
  signal: StorySignal;
  story: RoleplaySession & { sourceAvailable?: boolean };
  turn?: RoleplayTurn;
  items: StoryMessage[];
  earlier?: number;
}
export interface StorySync {
  signal: StorySignal;
  delta?: StoryDelta;
}
