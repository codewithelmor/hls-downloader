import React from "react";
import usePlayerCaptureController from "./PlayerCaptureController";
import PlayerCaptureView from "./PlayerCaptureView";

const PlayerCaptureModule = () => {
  const { activeTab, current, others, start, save, discard } =
    usePlayerCaptureController();
  return (
    <PlayerCaptureView
      canStart={activeTab !== undefined}
      current={current}
      others={others}
      start={start}
      save={save}
      discard={discard}
    />
  );
};

export default PlayerCaptureModule;
