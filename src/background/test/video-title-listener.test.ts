import { beforeEach, describe, expect, it, vi } from "vitest";
const browser = vi.hoisted(() => ({
  query: vi.fn(),
  executeScript: vi.fn(),
}));
vi.mock("webextension-polyfill", () => ({
  tabs: { query: browser.query },
  scripting: { executeScript: browser.executeScript },
}));
import { addVideoTitleListener } from "../src/listeners/addVideoTitleListener";

const UDEMY = "https://www.udemy.com/course/js/learn/lecture/40101198";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("video title listener", () => {
  let playlists: Record<string, any>;
  let notify: () => void;
  let store: any;

  beforeEach(() => {
    vi.resetAllMocks();
    playlists = {};
    store = {
      getState: () => ({ playlists: { playlists } }),
      dispatch: vi.fn(),
      subscribe: vi.fn((fn) => {
        notify = fn;
      }),
    };
    addVideoTitleListener(store);
    browser.query.mockResolvedValue([{ id: 10, url: UDEMY }]);
  });

  const capture = (initiator: string) => {
    playlists["p"] = { id: "p", uri: "p", initiator, createdAt: 1 };
    notify();
  };

  it("names a Udemy stream after the lecture title on the page", async () => {
    browser.executeScript.mockResolvedValue([
      { frameId: 0, result: "  23. Introducing the Modulo\n" },
    ]);
    capture(UDEMY);
    await flush();
    expect(browser.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 10 } }),
    );
    expect(store.dispatch).toHaveBeenCalledWith({
      type: "playlists/setPlaylistVideoTitle",
      payload: { playlistID: "p", videoTitle: "23. Introducing the Modulo" },
    });
  });

  it("reads each stream's title only once", async () => {
    browser.executeScript.mockResolvedValue([{ frameId: 0, result: "A" }]);
    capture(UDEMY);
    notify();
    notify();
    await flush();
    expect(browser.executeScript).toHaveBeenCalledTimes(1);
  });

  it("leaves the stream alone when the page cannot be read", async () => {
    browser.executeScript.mockRejectedValue(new Error("Cannot access page"));
    capture(UDEMY);
    await flush();
    expect(store.dispatch).not.toHaveBeenCalled();
  });

  it("does not touch pages without a title rule", async () => {
    capture("https://example.com/watch");
    await flush();
    expect(browser.query).not.toHaveBeenCalled();
    expect(browser.executeScript).not.toHaveBeenCalled();
  });
});
