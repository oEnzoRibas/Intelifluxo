import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ApiError,
  getEvent,
  getProfile,
  validId,
  type EventDetail,
  type Profile,
} from "./api";
type Load<T> =
  | { kind: "idle" | "loading" | "error" | "not-found" }
  | { kind: "ready"; data: T };
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function App() {
  const [view, setView] = useState<"overview" | "explorer">(() =>
    window.location.hash === "#explorer" ? "explorer" : "overview",
  );
  const viewRef = useRef(view);
  const request = useRef<AbortController | null>(null);
  const submittedId = useRef<string | null>(null);
  const [event, setEvent] = useState<Load<EventDetail>>({ kind: "idle" });
  useEffect(() => {
    function syncView() {
      const next =
        window.location.hash === "#explorer"
          ? "explorer"
          : window.location.hash === "#overview" || window.location.hash === ""
            ? "overview"
            : null;
      if (!next) return;
      if (
        viewRef.current === "explorer" &&
        next !== "explorer" &&
        request.current
      ) {
        request.current.abort();
        request.current = null;
        setEvent({ kind: "idle" });
      }
      viewRef.current = next;
      setView(next);
    }
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);
  const [profile, setProfile] = useState<Load<Profile>>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [showRetry, setShowRetry] = useState(false);
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    getProfile(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setProfile({ kind: "ready", data });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setProfile({ kind: "error" });
          setShowRetry(true);
        }
      });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => () => request.current?.abort(), []);
  function lookup(e: FormEvent) {
    e.preventDefault();
    const value = id.trim();
    request.current?.abort();
    request.current = null;
    if (!validId(value)) {
      submittedId.current = null;
      setError("Enter a lowercase UUID in the format shown.");
      setEvent({ kind: "idle" });
      return;
    }
    setError("");
    submittedId.current = value;
    const controller = new AbortController();
    request.current = controller;
    setEvent({ kind: "loading" });
    getEvent(value, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          request.current = null;
          setEvent({ kind: "ready", data });
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          request.current = null;
          setEvent({
            kind:
              err instanceof ApiError && err.kind === "not-found"
                ? "not-found"
                : "error",
          });
        }
      });
  }
  const lookupPanel = (
    <Panel title="Event lookup">
      <p className="muted">
        Find an event using its ID. Results are a point-in-time snapshot.
      </p>
      <form onSubmit={lookup} noValidate>
        <label htmlFor="event-id">Event ID</label>
        <div className="form-row">
          <input
            id="event-id"
            value={id}
            onChange={(e) => {
              const value = e.target.value;
              setId(value);
              if (
                submittedId.current !== null &&
                value.trim() !== submittedId.current
              ) {
                request.current?.abort();
                request.current = null;
                submittedId.current = null;
                setEvent({ kind: "idle" });
              }
              if (!value) {
                setError("");
              }
            }}
            placeholder="00000000-0000-0000-0000-000000000000"
            aria-invalid={!!error}
            aria-describedby={error ? "id-error" : "id-help"}
          />
          <button type="submit">Look up event</button>
        </div>
        <p id="id-help" className="help">
          Enter the lowercase UUID returned when the event was accepted.
        </p>
        {error && (
          <p id="id-error" className="notice" role="alert">
            {error}
          </p>
        )}
      </form>
      <div aria-live="polite" className="result">
        {event.kind === "idle" && <p>No event selected.</p>}
        {event.kind === "loading" && <p>Loading event…</p>}
        {event.kind === "not-found" && <p>No event found for this ID.</p>}
        {event.kind === "error" && (
          <p className="notice">
            Event lookup failed. Check the API connection and try again.
          </p>
        )}
        {event.kind === "ready" && (
          <>
            <h3>Event details</h3>
            <dl className="details">
              <dt>ID</dt>
              <dd>{event.data.id}</dd>
              <dt>Scope</dt>
              <dd>{event.data.scope}</dd>
              <dt>Created at</dt>
              <dd>{event.data.createdAt}</dd>
              <dt>Publication</dt>
              <dd>{event.data.publication}</dd>
              <dt>Status</dt>
              <dd>{event.data.status}</dd>
              <dt>Retry disposition</dt>
              <dd>
                {event.data.retry === null ? (
                  "Not available"
                ) : (
                  <pre
                    tabIndex={0}
                    role="region"
                    aria-label="Retry disposition"
                  >
                    {JSON.stringify(event.data.retry, null, 2)}
                  </pre>
                )}
              </dd>
              <dt>Content</dt>
              <dd>
                <pre tabIndex={0} role="region" aria-label="Event content">
                  {JSON.stringify(event.data.content, null, 2)}
                </pre>
              </dd>
              <dt>Result</dt>
              <dd>
                <pre tabIndex={0} role="region" aria-label="Event result">
                  {event.data.result === null
                    ? "Not available"
                    : JSON.stringify(event.data.result, null, 2)}
                </pre>
              </dd>
            </dl>
            {event.data.status === "retry_scheduled" && (
              <p className="notice">
                The retry schedule is persisted. Local execution requires
                scheduler and relay sweeps in this MVP.
              </p>
            )}
            {event.data.status === "retry_released" && (
              <p className="notice">
                The scheduler released the next generation. Its publication may
                be pending or confirmed; processing has not completed. The retry
                generation is the released generation; the other retry fields
                describe the preceding committed disposition.
              </p>
            )}
            <p className="muted">
              Publication and completion are independent. Look up again to
              refresh.
            </p>
          </>
        )}
      </div>
    </Panel>
  );
  return (
    <>
      <a className="skip" href="#main">
        Skip to main content
      </a>
      <div className="layout">
        <aside className="sidebar">
          <div className="brand">
            <span className="mark" aria-hidden="true">
              ✳
            </span>
            <div>
              <strong>InteliFluxo</strong>
              <small>Operations</small>
            </div>
          </div>
          <nav aria-label="Primary">
            <span className="nav-label">WORKSPACE</span>
            <a
              href="#overview"
              aria-current={view === "overview" ? "page" : undefined}
              onClick={() => {
                if (viewRef.current === "explorer" && request.current) {
                  request.current.abort();
                  request.current = null;
                  setEvent({ kind: "idle" });
                }
              }}
            >
              <span aria-hidden="true">▦</span> Overview
            </a>
            <a
              href="#explorer"
              aria-current={view === "explorer" ? "page" : undefined}
            >
              Event Explorer
            </a>
          </nav>
          <p className="side-note">
            Local development
            <br />
            <span>Read-only workspace</span>
          </p>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <span>
              Operations /{" "}
              <strong>
                {view === "overview" ? "Overview" : "Event Explorer"}
              </strong>
            </span>
            <span className="environment">Local profile</span>
          </header>
          <main id="main" tabIndex={-1}>
            {view === "overview" ? (
              <>
                <div className="heading">
                  <div>
                    <p className="eyebrow">OPERATIONS</p>
                    <h1>Operational Overview</h1>
                    <p>Service profile and event lookup.</p>
                  </div>
                </div>
                <div className="grid">
                  <Panel title="Service profile">
                    <div aria-live="polite">
                      {profile.kind === "loading" && (
                        <p>Loading service profile…</p>
                      )}
                      {profile.kind === "error" && (
                        <>
                          <p className="notice">
                            Service profile unavailable. The API could not be
                            reached or returned an unexpected response.
                          </p>
                        </>
                      )}
                      {profile.kind === "ready" && (
                        <>
                          <p>
                            <span className="badge">API responded</span>
                          </p>
                          <dl>
                            <dt>Profile</dt>
                            <dd>{profile.data.profile}</dd>
                          </dl>
                          <p className="muted">
                            A response does not indicate broker, database, or
                            worker health.
                          </p>
                          <h3>Reported limitations</h3>
                          {profile.data.limitations.length ? (
                            <ul>
                              {profile.data.limitations.map((x) => (
                                <li key={x}>{x}</li>
                              ))}
                            </ul>
                          ) : (
                            <p>No limitations reported.</p>
                          )}
                        </>
                      )}
                    </div>
                    {showRetry && (
                      <button
                        type="button"
                        aria-disabled={profile.kind === "loading"}
                        onClick={() => {
                          if (profile.kind === "loading") return;
                          setProfile({ kind: "loading" });
                          setRefresh((x) => x + 1);
                        }}
                      >
                        Retry
                      </button>
                    )}
                  </Panel>
                  <Panel title="Operational metrics">
                    <p className="unavailable">Unavailable</p>
                    <p className="muted">
                      Aggregate metrics are not provided by the current API.
                    </p>
                  </Panel>
                  {lookupPanel}
                  <Panel title="Recent events">
                    <p className="unavailable">Unavailable</p>
                    <p className="muted">
                      The current API does not provide an event list. Use event
                      lookup instead.
                    </p>
                  </Panel>
                </div>
              </>
            ) : (
              <>
                <div className="heading">
                  <div>
                    <p className="eyebrow">OPERATIONS</p>
                    <h1>Event Explorer</h1>
                    <p>Investigate an event by its known ID.</p>
                  </div>
                </div>
                <div className="explorer">
                  <p className="muted">
                    The API does not provide event discovery or a complete event
                    list. Enter an ID to retrieve a point-in-time snapshot.
                  </p>
                  {lookupPanel}
                </div>
              </>
            )}
          </main>
        </div>
      </div>
    </>
  );
}
export default App;
