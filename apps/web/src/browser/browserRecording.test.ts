import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { events, onFrame, registrySet, save, startScreencast, stopScreencast } = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    onFrame: vi.fn(() => vi.fn()),
    registrySet: vi.fn((_atom: unknown, value: string | null) => {
      events.push(value === null ? "clear" : `publish:${value}`);
    }),
    save: vi.fn(async () => ({
      id: "recording-test",
      tabId: "recording-tab",
      path: "/tmp/recording-test.webm",
      mimeType: "video/webm" as const,
      sizeBytes: 0,
      createdAt: "2026-06-26T00:00:00.000Z",
    })),
    startScreencast: vi.fn(async () => {
      events.push("start-screencast");
    }),
    stopScreencast: vi.fn(async () => undefined),
  };
});

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    recording: { onFrame, save, startScreencast, stopScreencast },
  },
}));

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { set: registrySet },
}));

vi.mock("./browserSurfaceStore", () => ({
  useBrowserSurfaceStore: {
    getState: () => ({ byTabId: {} }),
  },
}));

import {
  BrowserRecordingConflictError,
  BrowserRecordingOperationError,
  startBrowserRecording,
  stopBrowserRecording,
} from "./browserRecording";

class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }

  state: RecordingState = "inactive";
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    for (const listener of this.listeners.get("stop") ?? []) {
      if (typeof listener === "function") listener(new Event("stop"));
      else listener.handleEvent(new Event("stop"));
    }
  }
}

describe("browser recording surface preparation", () => {
  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        captureStream: () => ({}),
        getContext: () => ({ drawImage: vi.fn() }),
      }),
    });
    let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++frameId;
      queueMicrotask(() => {
        events.push(`paint:${id}`);
        callback(id);
      });
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes an inactive guest paintable before starting its screencast", async () => {
    await startBrowserRecording("recording-tab");

    expect(events).toEqual([
      "publish:recording-tab",
      "paint:1",
      "paint:2",
      "start-screencast",
      "publish:recording-tab",
    ]);

    await stopBrowserRecording("recording-tab");
  });

  it("does not report success for a second start while the first is still starting", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStartingScreencast?.();
    await firstStart;
    await stopBrowserRecording("recording-tab");
  });

  it("does not report success for a start while the recording is stopping", async () => {
    let finishStoppingScreencast: (() => void) | undefined;
    stopScreencast.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishStoppingScreencast = resolve;
      });
      return undefined;
    });

    await startBrowserRecording("recording-tab");
    const stopPromise = stopBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());

    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStoppingScreencast?.();
    await stopPromise;
  });

  it("shares an in-progress stop with duplicate callers", async () => {
    let finishStoppingScreencast: (() => void) | undefined;
    stopScreencast.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishStoppingScreencast = resolve;
      });
      return undefined;
    });

    await startBrowserRecording("recording-tab");
    const firstStop = stopBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());
    const duplicateStop = stopBrowserRecording("recording-tab");

    finishStoppingScreencast?.();
    const [firstArtifact, duplicateArtifact] = await Promise.all([firstStop, duplicateStop]);

    expect(duplicateArtifact).toEqual(firstArtifact);
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not start a screencast after stopping during the paint wait", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });

    const startPromise = startBrowserRecording("recording-tab");
    const rejectedStart = expect(startPromise).rejects.toBeInstanceOf(
      BrowserRecordingOperationError,
    );
    await vi.waitFor(() => expect(frameCallbacks).toHaveLength(1));

    const stopPromise = stopBrowserRecording("recording-tab");
    frameCallbacks.shift()?.(1);
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()?.(2);

    await rejectedStart;
    await stopPromise;
    expect(startScreencast).not.toHaveBeenCalled();
    expect(events).toEqual(["publish:recording-tab", "clear", "clear"]);
  });

  it("stops a screencast that finishes starting after cancellation", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const startPromise = startBrowserRecording("recording-tab");
    const rejectedStart = expect(startPromise).rejects.toBeInstanceOf(
      BrowserRecordingOperationError,
    );
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());
    finishStartingScreencast?.();

    await rejectedStart;
    await stopPromise;
    expect(stopScreencast).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toBe("clear");
  });

  it("does not release the recording slot until a cancelled start settles", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const firstStart = startBrowserRecording("recording-tab");
    const rejectedFirstStart = expect(firstStart).rejects.toBeInstanceOf(
      BrowserRecordingOperationError,
    );
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    const restartAfterStop = stopPromise.then(() => startBrowserRecording("recording-tab"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startCallsBeforeFirstSettled = startScreencast.mock.calls.length;

    finishStartingScreencast?.();
    await rejectedFirstStart;
    await stopPromise;
    await restartAfterStop;
    await stopBrowserRecording("recording-tab");

    expect(startCallsBeforeFirstSettled).toBe(1);
  });
});
