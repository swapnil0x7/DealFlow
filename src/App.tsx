import { useEffect, useState } from "react";
import { DealApi } from "./api/client";
import { WorkspaceSession } from "./features/collaboration/session";
import { PipelineWorkspace } from "./features/pipeline/PipelineWorkspace";
import { ApiError } from "./api/contracts";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; session: WorkspaceSession };

export default function App() {
  const [request, setRequest] = useState<{
    attempt: number;
    resetSeed?: number;
  }>({ attempt: 0 });
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    const api = new DealApi();
    let session: WorkspaceSession | undefined;
    async function load() {
      if (request.resetSeed !== undefined) await api.reset(request.resetSeed);
      const snapshot = await api.load();
      const configuration = await api.simulation();
      if (configuration.sessionId !== snapshot.sessionId)
        throw new ApiError(
          "session_expired",
          "The simulation reset during loading. Try again.",
        );
      if (active) {
        session = new WorkspaceSession(api, snapshot, configuration);
        setState({ status: "ready", session });
      }
    }
    void load().catch((error: unknown) => {
      if (active)
        setState({
          status: "error",
          message:
            error instanceof Error ? error.message : "Could not load deals.",
        });
    });
    return () => {
      active = false;
      session?.dispose();
      api.invalidate();
    };
  }, [request]);

  if (state.status === "ready")
    return (
      <PipelineWorkspace
        key={state.session.snapshot.sessionId}
        session={state.session}
        onReset={(seed) => {
          setState({ status: "loading" });
          setRequest((current) => ({
            attempt: current.attempt + 1,
            resetSeed: seed,
          }));
        }}
      />
    );

  return (
    <main className="workspace">
      <span className="eyebrow">Sales workspace</span>
      <h1>DealDesk</h1>
      {state.status === "loading" ? (
        <p role="status">Loading your pipeline…</p>
      ) : (
        <section role="alert">
          <h2>We couldn’t load your pipeline</h2>
          <p>{state.message}</p>
          <button
            onClick={() => {
              setState({ status: "loading" });
              setRequest((current) => ({
                ...current,
                attempt: current.attempt + 1,
              }));
            }}
          >
            Retry loading
          </button>
        </section>
      )}
    </main>
  );
}
