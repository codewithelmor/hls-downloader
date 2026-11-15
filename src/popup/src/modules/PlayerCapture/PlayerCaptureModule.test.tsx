// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { configureStore, type Middleware } from "@reduxjs/toolkit";
import { Provider } from "react-redux";
import { createRoot, Root } from "react-dom/client";
import { rootReducer } from "@hls-downloader/core/lib/store/root-reducer";
import { playerCaptureSlice } from "@hls-downloader/core/lib/store/slices";
import PlayerCaptureModule from "./PlayerCaptureModule";
import { describeProgress } from "./PlayerCaptureView";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  delete (globalThis as any).chrome;
});

async function render(activeTab?: { id: number; url: string }) {
  if (activeTab) {
    (globalThis as any).chrome = {
      tabs: { query: async () => [activeTab] },
    };
  }
  const actions: any[] = [];
  const record: Middleware = () => (next) => (action) => {
    actions.push(action);
    return next(action);
  };
  const store = configureStore({
    reducer: rootReducer,
    middleware: (getDefault) =>
      getDefault({ serializableCheck: false }).concat(record),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <Provider store={store}>
        <PlayerCaptureModule />
      </Provider>,
    );
  });
  return { container, store, actions };
}

const buttonByText = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;

const session = {
  id: "d:1",
  durationSeconds: 600,
  tracks: [
    {
      kind: "video" as const,
      mime: "video/mp4",
      segments: 40,
      bytes: 50 * 1024 * 1024,
      coveredSeconds: 125,
      gaps: 1,
      otherQualitySegments: 0,
      height: 720,
    },
    {
      kind: "audio" as const,
      mime: "audio/mp4",
      segments: 40,
      bytes: 2 * 1024 * 1024,
      coveredSeconds: 125,
      gaps: 0,
      otherQualitySegments: 0,
    },
  ],
};

describe("PlayerCaptureModule", () => {
  it("starts a capture in the active web page", async () => {
    const { container, actions } = await render({
      id: 7,
      url: "https://example.com/watch",
    });
    const start = buttonByText(container, "Start capture")!;
    expect(start.disabled).toBe(false);
    await act(async () => start.click());
    expect(actions).toContainEqual(
      playerCaptureSlice.actions.start({ tabId: 7 }),
    );
  });

  it("cannot start outside a web page", async () => {
    const { container } = await render({ id: 1, url: "chrome://newtab/" });
    expect(buttonByText(container, "Start capture")!.disabled).toBe(true);
  });

  it("shows progress and saves or discards the capture", async () => {
    const { container, store, actions } = await render({
      id: 7,
      url: "https://example.com/watch",
    });
    await act(async () => {
      store.dispatch(playerCaptureSlice.actions.start({ tabId: 7 }));
      store.dispatch(
        playerCaptureSlice.actions.update({
          tabId: 7,
          status: "capturing",
          sources: [session],
        }),
      );
    });
    expect(container.textContent).toContain("2:05 of 10:00");
    expect(container.textContent).toContain("1 gap");
    await act(async () => buttonByText(container, "Discard")!.click());
    expect(actions).toContainEqual(
      playerCaptureSlice.actions.cancel({ tabId: 7 }),
    );
    await act(async () => buttonByText(container, "Stop and save")!.click());
    expect(actions).toContainEqual(
      playerCaptureSlice.actions.finish({ tabId: 7 }),
    );
    // While saving, the capture can no longer be discarded.
    expect(buttonByText(container, "Discard")!.disabled).toBe(true);
  });

  it("explains a DRM-protected video and offers only to dismiss it", async () => {
    const { container, store } = await render({
      id: 7,
      url: "https://example.com/watch",
    });
    await act(async () => {
      store.dispatch(playerCaptureSlice.actions.start({ tabId: 7 }));
      store.dispatch(
        playerCaptureSlice.actions.update({
          tabId: 7,
          status: "protected",
          message: "This video is encrypted (DRM).",
        }),
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "encrypted",
    );
    expect(buttonByText(container, "Stop and save")).toBeUndefined();
    expect(buttonByText(container, "Dismiss")).toBeDefined();
  });
});

describe("describeProgress", () => {
  it("summarises the largest captured video", () => {
    const lines = describeProgress({
      tabId: 1,
      status: "capturing",
      startedAt: 0,
      sources: [session],
    });
    expect(lines[0]).toBe("2:05 of 10:00 · 52 MB · 720p · separate audio");
    expect(lines[1]).toMatch(/^1 gap:/);
  });
});
