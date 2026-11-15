import { describe, expect, it } from "vitest";
import { playlistsSlice } from "../src/store/slices/index.ts";

const { reducer, actions } = playlistsSlice;

describe("setPlaylistVideoTitle", () => {
  const added = reducer(
    undefined,
    actions.addPlaylist({
      id: "a",
      uri: "a",
      createdAt: 1,
      pageTitle: "Course | Udemy",
    }),
  );

  it("sets the title on a captured playlist", () => {
    const state = reducer(
      added,
      actions.setPlaylistVideoTitle({ playlistID: "a", videoTitle: "Intro" }),
    );
    expect(state.playlists.a).toMatchObject({
      pageTitle: "Course | Udemy",
      videoTitle: "Intro",
    });
    expect(state.playlistsStatus.a).toEqual({ status: "init" });
  });

  it("ignores playlists that were removed", () => {
    const state = reducer(
      added,
      actions.setPlaylistVideoTitle({ playlistID: "gone", videoTitle: "X" }),
    );
    expect(state.playlists.gone).toBeUndefined();
  });
});
