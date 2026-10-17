import { useCallback, useEffect, useRef, useState } from "react";
import type { Action } from "./api";
import { LiveChannelQueue, type LiveChannelsPatch } from "./liveChannelQueue";

export function useLiveChannels(action: Action) {
  const latestAction = useRef(action);
  latestAction.current = action;
  const queue = useRef<LiveChannelQueue | null>(null);
  const [pending, setPending] = useState<LiveChannelsPatch>({});

  useEffect(() => {
    const current = new LiveChannelQueue(
      (channels) =>
        latestAction.current(
          "/api/console/live/channels",
          { channels },
          "PATCH",
        ),
      setPending,
    );
    queue.current = current;
    return () => {
      current.dispose();
      if (queue.current === current) queue.current = null;
    };
  }, []);

  const patch = useCallback((channels: LiveChannelsPatch) => {
    queue.current?.enqueue(channels);
  }, []);
  return { patch, pending };
}
