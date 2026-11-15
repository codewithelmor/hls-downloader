import { RootState } from "@hls-downloader/core/lib/store/root-reducer";
import {
  playerCaptureSlice,
  type PlayerCaptureSession,
} from "@hls-downloader/core/lib/store/slices";
import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { getActiveTab, type ActiveTab } from "../../utils/active-tab";

export interface PlayerCaptureControllerResult {
  /** The tab the popup is open over, when it can be captured. */
  activeTab?: ActiveTab;
  /** Capture of the active tab, if any. */
  current?: PlayerCaptureSession;
  /** Captures running or waiting in other tabs. */
  others: PlayerCaptureSession[];
  start: () => void;
  save: (tabId: number) => void;
  discard: (tabId: number) => void;
}

const isSession = (
  session: PlayerCaptureSession | null,
): session is PlayerCaptureSession => session !== null;

const usePlayerCaptureController = (): PlayerCaptureControllerResult => {
  const dispatch = useDispatch();
  const [activeTab, setActiveTab] = useState<ActiveTab | undefined>();
  const sessions = useSelector<RootState, PlayerCaptureSession[]>(
    (state) =>
      Object.values(state.playerCapture?.sessions ?? {}).filter(isSession),
    (a, b) => a.length === b.length && a.every((item, i) => item === b[i]),
  );

  useEffect(() => {
    let alive = true;
    void getActiveTab().then((tab) => {
      if (alive) setActiveTab(tab);
    });
    return () => {
      alive = false;
    };
  }, []);

  const capturable =
    activeTab?.id !== undefined && /^https?:/i.test(activeTab.url ?? "")
      ? activeTab
      : undefined;
  const current = sessions.find((session) => session.tabId === activeTab?.id);

  return {
    activeTab: capturable,
    current,
    others: sessions
      .filter((session) => session !== current)
      .sort((a, b) => b.startedAt - a.startedAt),
    start: () => {
      if (capturable?.id === undefined) return;
      dispatch(playerCaptureSlice.actions.start({ tabId: capturable.id }));
    },
    save: (tabId) => dispatch(playerCaptureSlice.actions.finish({ tabId })),
    discard: (tabId) => dispatch(playerCaptureSlice.actions.cancel({ tabId })),
  };
};

export default usePlayerCaptureController;
