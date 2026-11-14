import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  roleplayExecutionLabel,
  type RoleplaySession,
  type StoryBookmark,
  type StoryMemory,
  type StoryMessage,
  type StoryNodeReference,
} from "../shared/roleplay.js";
import type { StoryState } from "../shared/storyState.js";
import { assert } from "./errors.js";
import type { Store } from "./store.js";

// The owning story's card, player and scenario are immutable. The reference
// avoids storing an avatar and setup again for every accepted reply.
interface StoryNode {
  formatVersion: 1;
  reference: StoryNodeReference;
  createdAt: number;
  memory: StoryMemory;
  storyState: StoryState;
}
interface BranchRequest {
  storyId: string;
  messageId: string;
  name: string;
  resultId: string;
}
const nameSchema = z.string().trim().min(1).max(100);
const bookmarkInput = z.strictObject({ name: nameSchema });
const branchInput = z.strictObject({ name: nameSchema, requestId: z.uuid() });
const messages = (id: string) => `story-messages:${id}`;
const nodes = (id: string) => `story-nodes:${id}`;
const bookmarks = (id: string) => `story-bookmarks:${id}`;

export class StoryBranches {
  constructor(
    private store: Store,
    private assertUnlocked: () => void,
    private onBookmarkChange: (id: string) => void = () => {},
  ) {}

  private story(id: string) {
    const story = this.store.get<RoleplaySession>("stories", id);
    assert(story, "故事不存在", "NOT_FOUND", 404);
    return story;
  }

  private node(storyId: string, messageId: string) {
    const message = this.store.get<StoryMessage>(messages(storyId), messageId);
    assert(message?.sessionId === storyId, "消息不存在", "NOT_FOUND", 404);
    const node = this.store.get<StoryNode>(nodes(storyId), messageId);
    assert(
      message.role === "assistant" &&
        node?.formatVersion === 1 &&
        node.reference.storyId === storyId &&
        node.reference.messageId === messageId &&
        node.reference.seq === message.seq &&
        node.reference.round === message.nodeRound,
      "此消息没有可用的剧情节点",
      "STORY_NODE_UNAVAILABLE",
      409,
    );
    return node;
  }

  // Called inside the accepted-turn transaction.
  record(story: RoleplaySession, message: StoryMessage, round: number) {
    const text = (message.narration?.trim() || message.text.trim()).replace(
      /\s+/gu,
      " ",
    );
    const node: StoryNode = {
      formatVersion: 1,
      reference: {
        storyId: story.id,
        storyTitle: story.title,
        messageId: message.id,
        seq: message.seq,
        round,
        summary: text.length > 120 ? text.slice(0, 119) + "…" : text,
      },
      createdAt: message.at,
      memory: story.memory,
      storyState: story.storyState,
    };
    this.store.set(nodes(story.id), message.id, node);
  }

  withBookmark(message: StoryMessage): StoryMessage {
    return message.nodeRound
      ? {
          ...message,
          bookmarked: this.store.has(bookmarks(message.sessionId), message.id),
        }
      : message;
  }

  list(storyId: string, before?: number) {
    this.story(storyId);
    const page = this.store.page<StoryBookmark>(bookmarks(storyId), 30, before);
    return {
      items: page.items,
      cursor: page.items.length === 30 ? page.cursor : undefined,
    };
  }

  save(storyId: string, messageId: string, raw: unknown) {
    this.assertUnlocked();
    const { name } = bookmarkInput.parse(raw);
    const story = this.story(storyId);
    const { reference } = this.node(storyId, messageId);
    const existing = this.store.get<StoryBookmark>(
      bookmarks(storyId),
      messageId,
    );
    if (existing) return existing;
    const value: StoryBookmark = {
      node: { ...reference, storyTitle: story.title },
      name,
      savedAt: Date.now(),
    };
    this.store.set(bookmarks(storyId), messageId, value);
    this.onBookmarkChange(storyId);
    return value;
  }

  rename(storyId: string, messageId: string, raw: unknown) {
    this.assertUnlocked();
    const { name } = bookmarkInput.parse(raw);
    this.story(storyId);
    const existing = this.store.get<StoryBookmark>(
      bookmarks(storyId),
      messageId,
    );
    assert(existing, "存档不存在", "NOT_FOUND", 404);
    const value = { ...existing, name };
    this.store.set(bookmarks(storyId), messageId, value);
    this.onBookmarkChange(storyId);
    return value;
  }

  remove(storyId: string, messageId: string) {
    this.assertUnlocked();
    this.story(storyId);
    this.store.delete(bookmarks(storyId), messageId);
    this.onBookmarkChange(storyId);
  }

  clear(storyId: string) {
    this.store.clear(bookmarks(storyId));
    this.store.clear(nodes(storyId));
  }

  fork(storyId: string, messageId: string, raw: unknown) {
    const { name, requestId } = branchInput.parse(raw);
    return this.store.transaction(() => {
      const prior = this.store.get<BranchRequest>(
        "story-branch-requests",
        requestId,
      );
      if (prior) {
        assert(
          prior.storyId === storyId &&
            prior.messageId === messageId &&
            prior.name === name,
          "重复请求内容不一致",
          "DUPLICATE_REQUEST",
          409,
        );
        return this.story(prior.resultId);
      }
      this.assertUnlocked();
      const source = this.story(storyId);
      const node = this.node(storyId, messageId);
      const id = randomUUID();
      const now = Date.now();
      const remapped = new Map<string, string>();
      const stateOf = (snapshot: StoryNode): StoryState => {
        const state = snapshot.storyState;
        if (!state.lastUpdate) return state;
        const mappedId = remapped.get(state.lastUpdate.messageId);
        assert(
          mappedId,
          "剧情状态引用不在节点范围内",
          "STORY_NODE_UNAVAILABLE",
          409,
        );
        return {
          ...state,
          lastUpdate: { ...state.lastUpdate, messageId: mappedId },
        };
      };
      let lastSeq = 0;
      while (lastSeq < node.reference.seq) {
        const prefix = this.store.storyRange<StoryMessage>(
          messages(storyId),
          lastSeq,
          node.reference.seq + 1,
          100,
        );
        assert(
          prefix.length,
          "剧情节点缺少历史消息",
          "STORY_NODE_UNAVAILABLE",
          409,
        );
        for (const message of prefix) {
          assert(
            message.sessionId === storyId && message.seq === lastSeq + 1,
            "剧情节点的历史顺序不完整",
            "STORY_NODE_UNAVAILABLE",
            409,
          );
          lastSeq = message.seq;
          const copyId = randomUUID();
          remapped.set(message.id, copyId);
          const copied: StoryMessage = {
            id: copyId,
            sessionId: id,
            seq: message.seq,
            at: message.at,
            role: message.role,
            text: message.text,
            narration: message.narration,
            replyOptions: message.replyOptions,
            storyChanges: message.storyChanges,
            nodeRound: message.nodeRound,
            inheritedFrom: message.inheritedFrom ?? {
              storyId,
              storyTitle: source.title,
              messageId: message.id,
            },
            actionRecord: message.actionRecord,
            historicalControl:
              message.historicalControl ??
              (message.control && message.output
                ? {
                    label: roleplayExecutionLabel(message.control, true),
                    reason: message.controlReason,
                    targets: {
                      A: message.output.A.target,
                      B: message.output.B.target,
                    },
                  }
                : undefined),
          };
          this.store.set(messages(id), copyId, copied);
          if (message.nodeRound) {
            const original = this.node(storyId, message.id);
            this.store.set(nodes(id), copyId, {
              ...original,
              reference: {
                ...original.reference,
                storyId: id,
                storyTitle: name,
                messageId: copyId,
              },
              storyState: stateOf(original),
            } satisfies StoryNode);
          }
        }
      }
      assert(
        remapped.has(messageId),
        "剧情节点不在消息前缀内",
        "STORY_NODE_UNAVAILABLE",
        409,
      );
      const result: RoleplaySession = {
        id,
        title: name,
        card: source.card,
        player: source.player,
        scenario: source.scenario,
        createdAt: now,
        updatedAt: now,
        revision: 0,
        origin: { ...node.reference, storyTitle: source.title },
        completedRounds: node.reference.round,
        memory: node.memory,
        storyState: stateOf(node),
      };
      this.store.set("stories", id, result);
      this.store.set("story-branch-requests", requestId, {
        storyId,
        messageId,
        name,
        resultId: id,
      } satisfies BranchRequest);
      return result;
    });
  }
}
