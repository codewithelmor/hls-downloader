import { combineEpics, Epic } from "redux-observable";
import { defer, from, Observable, of } from "rxjs";
import { catchError, filter, mergeMap, takeUntil } from "rxjs/operators";
import { RootAction, RootState } from "../store/root-reducer";
import { jobsSlice, playerCaptureSlice } from "../store/slices";
import { Dependencies, IPlayerCapture } from "../services";
import { capturedFileName, saveCapturedSourceFactory } from "../use-cases";
import type { Job } from "../entities";

type CaptureEpic = Epic<RootAction, RootAction, RootState, Dependencies>;

const UNAVAILABLE =
  "Capturing from the player is not available in this browser.";

function newJobId(): string {
  return (
    (crypto as any)?.randomUUID?.() ??
    `job-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return (error as Error)?.message || fallback;
}

const isEndOf = (tabId: number) => (action: RootAction) =>
  (playerCaptureSlice.actions.finish.match(action) ||
    playerCaptureSlice.actions.cancel.match(action)) &&
  action.payload.tabId === tabId;

const startEpic: CaptureEpic = (action$, _state$, { playerCapture }) =>
  action$.pipe(
    filter(playerCaptureSlice.actions.start.match),
    mergeMap(({ payload: { tabId } }) => {
      if (!playerCapture) {
        return of(
          playerCaptureSlice.actions.failed({ tabId, message: UNAVAILABLE }),
        );
      }
      return new Observable<RootAction>((subscriber) => {
        let active = true;
        playerCapture
          .start(tabId, (update) => {
            if (active) {
              subscriber.next(
                playerCaptureSlice.actions.update({ tabId, ...update }),
              );
            }
          })
          .then(
            (info) => {
              if (active) {
                subscriber.next(
                  playerCaptureSlice.actions.started({ tabId, ...info }),
                );
              }
            },
            (error: unknown) => {
              if (!active) return;
              subscriber.next(
                playerCaptureSlice.actions.failed({
                  tabId,
                  message: errorMessage(error, "Could not start the capture"),
                }),
              );
              subscriber.complete();
            },
          );
        return () => {
          active = false;
        };
      }).pipe(takeUntil(action$.pipe(filter(isEndOf(tabId)))));
    }),
  );

async function saveCapture(
  capture: IPlayerCapture,
  deps: Dependencies,
  tabId: number,
  fallbackTitle: string | undefined,
): Promise<Job[]> {
  const sources = await capture.finish(tabId);
  const save = saveCapturedSourceFactory(deps.fs);
  const jobs: Job[] = [];
  const usable = sources.filter((source) =>
    source.tracks.some((track) => track.fragments.length > 0),
  );
  for (const [index, source] of usable.entries()) {
    const suffix = usable.length > 1 ? ` (${index + 1})` : "";
    const job = await save(source, {
      jobId: newJobId(),
      filename: capturedFileName(source.title ?? fallbackTitle, suffix),
      createdAt: Date.now() + index,
    });
    if (job) jobs.push(job);
  }
  if (jobs.length === 0) {
    throw new Error(
      "Nothing was captured. Play the video while the capture is running, then try again.",
    );
  }
  // Only drop the recorded data once every job holds its own copy, so a
  // failed save can be retried.
  await capture.discard(tabId);
  return jobs;
}

const finishEpic: CaptureEpic = (action$, state$, deps) =>
  action$.pipe(
    filter(playerCaptureSlice.actions.finish.match),
    mergeMap(({ payload: { tabId } }) => {
      const capture = deps.playerCapture;
      if (!capture) {
        return of(
          playerCaptureSlice.actions.failed({ tabId, message: UNAVAILABLE }),
        );
      }
      const title = state$.value.playerCapture.sessions[tabId]?.title;
      return defer(() => from(saveCapture(capture, deps, tabId, title))).pipe(
        mergeMap((jobs) =>
          of<RootAction[]>(
            ...jobs.map((job) => jobsSlice.actions.addCaptured({ job })),
            playerCaptureSlice.actions.finished({
              tabId,
              jobIds: jobs.map((job) => job.id),
            }),
          ),
        ),
        catchError((error: unknown) =>
          of(
            playerCaptureSlice.actions.failed({
              tabId,
              message: errorMessage(error, "Could not save the capture"),
            }),
          ),
        ),
      );
    }),
  );

const cancelEpic: CaptureEpic = (action$, _state$, { playerCapture }) =>
  action$.pipe(
    filter(playerCaptureSlice.actions.cancel.match),
    mergeMap(({ payload: { tabId } }) =>
      defer(() => from(playerCapture?.cancel(tabId) ?? Promise.resolve())).pipe(
        catchError((error: unknown) => {
          console.warn("[player-capture] cancel failed", error);
          return of(undefined);
        }),
        mergeMap(() => of(playerCaptureSlice.actions.cancelled({ tabId }))),
      ),
    ),
  );

export const playerCaptureEpic: CaptureEpic = combineEpics(
  startEpic,
  finishEpic,
  cancelEpic,
);
