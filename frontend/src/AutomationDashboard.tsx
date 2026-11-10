import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  listSummaries,
  validText,
  type SummaryPage,
  type AutomationSummary,
} from "./automation-api";

type Request = {
  q: string;
  active: string;
  cursor: string | null;
  history: (string | null)[];
  focus: boolean;
  serial: number;
};
type Result =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; page: SummaryPage };
const initial: Request = {
  q: "",
  active: "all",
  cursor: null,
  history: [],
  focus: false,
  serial: 0,
};

export default function AutomationDashboard({
  visible,
  onOpen,
}: {
  visible: boolean;
  onOpen: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [request, setRequest] = useState<Request>(initial);
  const [committed, setCommitted] = useState<Request>(initial);
  const [result, setResult] = useState<Result>({ kind: "loading" });
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) setResult({ kind: "loading" });
  }
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const version = ++sequence.current;
    listSummaries(request, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || version !== sequence.current) return;
        setCommitted(request);
        setResult({ kind: "ready", page });
        if (request.focus) heading.current?.focus();
      })
      .catch(() => {
        if (!controller.signal.aborted && version === sequence.current)
          setResult({ kind: "error" });
      });
    return () => controller.abort();
  }, [request, visible]);
  function load(next: Omit<Request, "serial">) {
    sequence.current++;
    setResult({ kind: "loading" });
    setRequest((r) => ({ ...next, serial: r.serial + 1 }));
  }
  function search(e: FormEvent) {
    e.preventDefault();
    if (draft !== "" && !validText(draft, 200)) {
      setInvalid(true);
      input.current?.focus();
      return;
    }
    setInvalid(false);
    load({
      q: draft,
      active: request.active,
      cursor: null,
      history: [],
      focus: false,
    });
  }
  function reset() {
    setDraft("");
    setInvalid(false);
    load({ q: "", active: "all", cursor: null, history: [], focus: false });
  }
  function openLink(item: AutomationSummary) {
    return (
      <a
        className="dashboard-open"
        href={`#automations/${item.id}`}
        aria-label={`Open Builder for ${item.name}, ${item.scope}`}
        onClick={onOpen}
      >
        Open Builder
      </a>
    );
  }
  return (
    <div hidden={!visible} className="dashboard">
      <p className="eyebrow">WORKFLOWS / AUTOMATIONS</p>
      <div className="heading">
        <div>
          <h1>Automation Management</h1>
          <p>
            Discover automations across scopes. Open the Builder to edit a
            definition.
          </p>
        </div>
        <a className="button-link" href="#automations/create">
          + Create Automation
        </a>
      </div>
      <p className="dashboard-limit">
        Local development only / No authentication or tenant isolation /
        Synthetic data only
      </p>
      <div className="dashboard-controls">
        <form onSubmit={search} noValidate>
          <label htmlFor="dashboard-search">Search name or scope</label>
          <div className="form-row">
            <input
              id="dashboard-search"
              ref={input}
              value={draft}
              placeholder="Search all scopes"
              onChange={(e) => {
                setDraft(e.target.value);
                setInvalid(false);
              }}
              aria-invalid={invalid}
              aria-describedby={invalid ? "search-error" : undefined}
            />
            <button>Search</button>
          </div>
          {invalid && (
            <p id="search-error" role="alert">
              Enter a valid search of up to 200 characters, or leave it blank.
            </p>
          )}
        </form>
        <fieldset className="dashboard-status">
          <legend>Status</legend>
          {[
            ["all", "All"],
            ["true", "Active"],
            ["false", "Inactive"],
          ].map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="dashboard-status"
                value={value}
                checked={request.active === value}
                onChange={() =>
                  load({
                    q: request.q,
                    active: value,
                    cursor: null,
                    history: [],
                    focus: false,
                  })
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <button className="dashboard-reset" onClick={reset}>
          Reset filters
        </button>
      </div>
      <section
        className="dashboard-results"
        aria-labelledby="dashboard-results-heading"
        aria-busy={result.kind === "loading"}
      >
        <h2 id="dashboard-results-heading" ref={heading} tabIndex={-1}>
          Current results
        </h2>
        <p className="muted">Ordered by ID / Live results, not a snapshot</p>
        <p role="status" className="sr-only">
          {result.kind === "loading"
            ? "Loading automations"
            : result.kind === "ready"
              ? "Results updated"
              : ""}
        </p>
        {result.kind === "loading" ? (
          <p>Loading automations…</p>
        ) : result.kind === "error" ? (
          <div>
            <p role="alert">
              The automation service could not return results. Try again.
            </p>
            <button onClick={() => load({ ...request, focus: true })}>
              Retry
            </button>
            <button onClick={reset}>Reset filters</button>
          </div>
        ) : (
          <>
            {result.page.items.length === 0 ? (
              <div className="dashboard-empty">
                {committed.cursor !== null ? (
                  <>
                    <h3>No more current matches</h3>
                    <p>
                      Results may have changed. Go back or restart the list.
                    </p>
                  </>
                ) : committed.q || committed.active !== "all" ? (
                  <>
                    <h3>No matching automations</h3>
                    <p>Try another search or reset filters.</p>
                    <button onClick={reset}>Reset filters</button>
                  </>
                ) : (
                  <>
                    <h3>No automations yet</h3>
                    <p>Create an automation to get started.</p>
                    <a className="button-link" href="#automations/create">
                      Create Automation
                    </a>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="dashboard-table">
                  <table>
                    <thead>
                      <tr>
                        {[
                          "Name",
                          "Scope",
                          "Status",
                          "Revision",
                          "Schema",
                          "Workflow",
                          "Action",
                        ].map((x) => (
                          <th scope="col" key={x}>
                            {x}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.page.items.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <strong>{item.name}</strong>
                            <br />
                            <small>Current definition</small>
                          </td>
                          <td>{item.scope}</td>
                          <td>
                            <span
                              className={item.active ? "dashboard-active" : ""}
                            >
                              {item.active ? "Active" : "Inactive"}
                            </span>
                          </td>
                          <td>{item.revision}</td>
                          <td>v{item.schemaVersion}</td>
                          <td>v{item.workflowVersion}</td>
                          <td>{openLink(item)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="dashboard-cards">
                  {result.page.items.map((item) => (
                    <li key={item.id}>
                      <h3>{item.name}</h3>
                      <p>Current definition</p>
                      <dl>
                        <dt>Scope</dt>
                        <dd>{item.scope}</dd>
                        <dt>Status</dt>
                        <dd>{item.active ? "Active" : "Inactive"}</dd>
                        <dt>Revision</dt>
                        <dd>{item.revision}</dd>
                        <dt>Schema</dt>
                        <dd>v{item.schemaVersion}</dd>
                        <dt>Workflow</dt>
                        <dd>v{item.workflowVersion}</dd>
                      </dl>
                      {openLink(item)}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(result.page.items.length > 0 || committed.cursor !== null) && (
              <div className="dashboard-pagination">
                <p>
                  {result.page.nextCursor
                    ? "More results available."
                    : "End of current results."}
                </p>
                <div>
                  <button
                    disabled={!committed.history.length}
                    onClick={() =>
                      load({
                        ...committed,
                        cursor: committed.history[committed.history.length - 1],
                        history: committed.history.slice(0, -1),
                        focus: true,
                      })
                    }
                  >
                    Previous
                  </button>
                  <button
                    disabled={!result.page.nextCursor}
                    onClick={() =>
                      load({
                        ...committed,
                        cursor: result.page.nextCursor,
                        history: [...committed.history, committed.cursor],
                        focus: true,
                      })
                    }
                  >
                    Next
                  </button>
                  <button
                    onClick={() =>
                      load({
                        ...committed,
                        cursor: null,
                        history: [],
                        focus: true,
                      })
                    }
                  >
                    Restart list
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
