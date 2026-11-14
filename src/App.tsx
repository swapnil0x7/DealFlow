import { useEffect, useState } from "react";
import { DealApi } from "./api/client";
import { STAGES } from "./domain/deal";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; dealCount: number; ownerCount: number };

export default function App() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    const api = new DealApi();
    api
      .load()
      .then((snapshot) => {
        if (active)
          setState({
            status: "ready",
            dealCount: snapshot.deals.length,
            ownerCount: snapshot.owners.length,
          });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            status: "error",
            message:
              error instanceof Error ? error.message : "Could not load deals.",
          });
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <main className="workspace">
      /
      <header>
        <span className="eyebrow">Sales workspace</span>
        <h1>DealDesk</h1>
      </header>
      {state.status === "loading" && (
        <p role="status">Loading your pipeline…</p>
      )}
      {state.status === "error" && (
        <section role="alert">
          <h2>We couldn't load your pipeline</h2>
          <p>{state.message}</p>
          <button
            onClick={() => {
              setState({ status: "loading" });
              setAttempt((value) => value + 1);
            }}
          >
            Retry loading
          </button>
        </section>
      )}
      {state.status === "ready" && (
        <section aria-label="Pipeline summary">
          <h2>Your pipeline is ready</h2>
          <dl className="summary">
            <div>
              <dt>Deals</dt>
              <dd>{state.dealCount.toLocaleString("en-IN")}</dd>
            </div>
            <div>
              <dt>Salespeople</dt>
              <dd>{state.ownerCount}</dd>
            </div>
            <div>
              <dt>Stages</dt>
              <dd>{STAGES.length}</dd>
            </div>
          </dl>
        </section>
      )}
    </main>
  );
}
