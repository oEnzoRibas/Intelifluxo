import Overview from "./Overview";
import Automations from "./Automations";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ApiError, getEvent, validId, type EventDetail } from "./api";
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
  const [route, setRoute] = useState(window.location.hash);
  const [view, setView] = useState<"overview" | "explorer" | "automations">(
    () =>
      window.location.hash.startsWith("#automations")
        ? "automations"
        : window.location.hash.startsWith("#explorer")
          ? "explorer"
          : "overview",
  );
  const viewRef = useRef(view);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const pageTitle =
    view === "overview"
      ? "Visão geral"
      : view === "explorer"
        ? "Explorador de eventos"
        : /\/builder$/i.test(route)
          ? "Editor de fluxo"
          : "Automações";
  useEffect(() => {
    document.title = `${pageTitle} | InteliFluxo`;
  }, [pageTitle]);
  const request = useRef<AbortController | null>(null);
  const submittedId = useRef<string | null>(null);
  const [event, setEvent] = useState<Load<EventDetail>>({ kind: "idle" });
  const [id, setId] = useState(() => {
    const value =
      new URLSearchParams(window.location.hash.split("?")[1] ?? "").get(
        "eventId",
      ) ?? "";
    return validId(value) ? value : "";
  });
  useEffect(() => {
    function syncView() {
      const next = window.location.hash.startsWith("#automations")
        ? "automations"
        : window.location.hash.startsWith("#explorer")
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
      setRoute(window.location.hash);
      if (window.matchMedia?.("(max-width: 767px)").matches && menuRef.current)
        menuRef.current.open = false;
      if (next === "explorer") {
        const eventId = new URLSearchParams(
          window.location.hash.split("?")[1] ?? "",
        ).get("eventId");
        if (eventId && validId(eventId)) {
          request.current?.abort();
          setEvent({ kind: "idle" });
          submittedId.current = null;
          setId(eventId);
        }
      }
    }
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);
  const [error, setError] = useState("");
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
        Find an event using its ID. Select Look up event to retrieve a
        point-in-time snapshot, including when an ID is prefilled.
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
        Ir para o conteúdo principal
      </a>
      <div
        className={`layout${/^#automations\/[0-9a-f-]+\/builder$/i.test(route) ? " layout--builder" : ""}`}
      >
        <aside className="sidebar">
          <div className="brand">
            <span className="mark" aria-hidden="true">
              ✳
            </span>
            <div>
              <strong>InteliFluxo</strong>
              <small>Operações</small>
            </div>
          </div>
          <details
            ref={menuRef}
            className="mobile-menu"
            open={!(window.matchMedia?.("(max-width: 767px)").matches ?? false)}
          >
            <summary>Menu</summary>
            <nav
              aria-label="Navegação principal"
              onClick={(event) => {
                if (
                  (event.target as HTMLElement).closest("a") &&
                  window.matchMedia?.("(max-width: 767px)").matches &&
                  menuRef.current
                )
                  menuRef.current.open = false;
              }}
            >
              <a
                href="#overview"
                aria-current={view === "overview" ? "page" : undefined}
              >
                Visão geral
              </a>
              <a
                href="#automations"
                aria-current={view === "automations" ? "page" : undefined}
              >
                Automações
              </a>
              <details>
                <summary>Avançado / Diagnóstico</summary>
                <a
                  href="#explorer"
                  aria-current={view === "explorer" ? "page" : undefined}
                >
                  Event Explorer
                </a>
              </details>
            </nav>
          </details>
          <p className="side-note">
            Ambiente local
            <br />
            <span>Operações e automações</span>
          </p>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <span>
              Operações / <strong>{pageTitle}</strong>
            </span>
            <span className="environment">Ambiente local</span>
          </header>
          <main id="main" tabIndex={-1}>
            {view === "automations" ? (
              <Automations route={route} />
            ) : view === "overview" ? (
              <Overview />
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
