import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, validId } from "./api";
import {
  ConflictError,
  createDefinition,
  getDefinition,
  listDefinitions,
  listExecutions,
  updateDefinition,
  validText,
  type Definition,
  type Execution,
} from "./automation-api";

type State<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; message: string };
const message = (e: unknown) =>
  e instanceof ApiError && e.kind === "invalid"
    ? "The service returned an unexpected response."
    : e instanceof ApiError && e.kind === "not-found"
      ? "This automation was not found."
      : "The automation service is unavailable. Try again.";
export default function Automations({ route }: { route: string }) {
  const [scope, setScope] = useState("");
  const [selectedScope, setSelectedScope] = useState("");
  const [name, setName] = useState("");
  const [validation, setValidation] = useState("");
  const [list, setList] = useState<State<Definition[]>>({
    kind: "ready",
    data: [],
  });
  const [detail, setDetail] = useState<State<Definition>>({ kind: "loading" });
  const [history, setHistory] = useState<State<Execution[]>>({
    kind: "loading",
  });
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [refreshingDetail, setRefreshingDetail] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const mutation = useRef<AbortController | null>(null);
  const detailReadVersion = useRef(0);
  const scopeInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const id = route.startsWith("#automations/")
    ? route.slice("#automations/".length)
    : "";
  const create = id === "create";
  // A hash can change through browser history or a direct link, not just our
  // list links. Never show the previous route's snapshot under a new ID.
  const [previousId, setPreviousId] = useState(id);
  if (previousId !== id) {
    setPreviousId(id);
    setDetail({ kind: "loading" });
    setHistory({ kind: "loading" });
    if (!id && selectedScope) setList({ kind: "loading" });
  }
  useEffect(() => {
    setPending(false);
    setMutationError("");
    setValidation("");
    setRefreshingDetail(false);
    return () => {
      mutation.current?.abort();
      mutation.current = null;
    };
  }, [route]);
  useEffect(() => {
    if (id || !selectedScope) return;
    const controller = new AbortController();
    listDefinitions(selectedScope, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setList({ kind: "ready", data });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setList({ kind: "error", message: message(e) });
      });
    return () => controller.abort();
  }, [id, selectedScope, refresh]);
  useEffect(() => {
    if (!id || create) return;
    const controller = new AbortController();
    if (!validId(id)) {
      return () => controller.abort();
    }
    const readVersion = ++detailReadVersion.current;
    getDefinition(id, controller.signal)
      .then((data) => {
        if (
          !controller.signal.aborted &&
          readVersion === detailReadVersion.current
        ) {
          setDetail({ kind: "ready", data });
          setRefreshingDetail(false);
        }
      })
      .catch((e) => {
        if (
          !controller.signal.aborted &&
          readVersion === detailReadVersion.current
        ) {
          setDetail({ kind: "error", message: message(e) });
          setRefreshingDetail(false);
        }
      });
    listExecutions(id, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setHistory({ kind: "ready", data });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setHistory({ kind: "error", message: message(e) });
      });
    return () => controller.abort();
  }, [id, create, refresh]);
  function reload(preserveDetail = false) {
    if (pending) return;
    setMutationError("");
    if (id && !create) {
      if (preserveDetail) setRefreshingDetail(true);
      else setDetail({ kind: "loading" });
      setHistory({ kind: "loading" });
    } else setList({ kind: "loading" });
    setRefresh((x) => x + 1);
  }
  function selectScope(e: FormEvent) {
    e.preventDefault();
    if (!validText(scope, 128)) {
      setValidation("Enter a valid scope (up to 128 characters).");
      scopeInput.current?.focus();
      return;
    }
    setValidation("");
    setList({ kind: "loading" });
    if (scope === selectedScope) setRefresh((x) => x + 1);
    else setSelectedScope(scope);
  }
  async function createAutomation(e: FormEvent) {
    e.preventDefault();
    if (!validText(scope, 128) || !validText(name, 200)) {
      setValidation(
        "Enter a valid scope and name (up to 128 and 200 characters respectively).",
      );
      (!validText(scope, 128) ? scopeInput : nameInput).current?.focus();
      return;
    }
    setValidation("");
    setMutationError("");
    setPending(true);
    const controller = new AbortController();
    mutation.current = controller;
    try {
      const d = await createDefinition(scope, name, controller.signal);
      if (!controller.signal.aborted) {
        setSelectedScope(scope);
        setDetail({ kind: "loading" });
        setHistory({ kind: "loading" });
        window.location.hash = `#automations/${d.id}`;
      }
    } catch (err) {
      if (!controller.signal.aborted)
        setMutationError(
          `${message(err)} Creation may have succeeded; check the list before retrying.`,
        );
    } finally {
      if (!controller.signal.aborted) {
        setPending(false);
        mutation.current = null;
      }
    }
  }
  async function toggle(d: Definition) {
    if (
      !window.confirm(
        `${d.active ? "Deactivate" : "Activate"} ${d.name} at revision ${d.revision}?`,
      )
    )
      return;
    // A read that began before this write cannot establish its outcome, even
    // when the write fails or its response is delayed.
    detailReadVersion.current++;
    setRefreshingDetail(false);
    setPending(true);
    setMutationError("");
    const controller = new AbortController();
    mutation.current = controller;
    try {
      const updated = await updateDefinition(d, controller.signal);
      if (!controller.signal.aborted)
        setDetail({ kind: "ready", data: updated });
    } catch (err) {
      if (!controller.signal.aborted) {
        if (err instanceof ConflictError) {
          setMutationError(
            "This revision is stale. Reload the latest definition before trying again.",
          );
          setDetail({
            kind: "error",
            message: "Revision conflict: the definition changed.",
          });
        } else
          setMutationError(
            `${message(err)} The update may have succeeded; reload before retrying.`,
          );
      }
    } finally {
      if (!controller.signal.aborted) {
        setPending(false);
        mutation.current = null;
      }
    }
  }
  return (
    <div className="automations">
      <p className="eyebrow">WORKFLOWS / AUTOMATIONS</p>
      {!id ? (
        <>
          <div className="heading">
            <div>
              <h1>Automations</h1>
              <p>Manage receipt automations by scope.</p>
            </div>
            <a
              className="button-link"
              href="#automations/create"
              onClick={() => setScope(selectedScope)}
            >
              Create Automation
            </a>
          </div>
          <section className="panel">
            <h2>Receipt automation</h2>
            <p>Fixed trigger: receipt.v1 → Fixed action: record-receipt.v1</p>
            <form onSubmit={selectScope} noValidate>
              <label htmlFor="scope-filter">Scope</label>
              <div className="form-row">
                <input
                  id="scope-filter"
                  ref={scopeInput}
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  aria-describedby={validation ? "scope-error" : undefined}
                  aria-invalid={!!validation}
                />
                <button>Load automations</button>
              </div>
              {validation && (
                <p id="scope-error" role="alert" className="notice">
                  {validation}
                </p>
              )}
            </form>
          </section>
          {selectedScope && (
            <section className="panel" aria-live="polite">
              <h2>Automations in {selectedScope}</h2>
              {list.kind === "loading" ? (
                <p>Loading automations…</p>
              ) : list.kind === "error" ? (
                <>
                  <p role="alert">{list.message}</p>
                  <button onClick={() => reload()}>Retry</button>
                </>
              ) : list.data.length === 0 ? (
                <p>No automations yet.</p>
              ) : (
                <>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>State</th>
                          <th>Revision</th>
                          <th>Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.data.map((d) => (
                          <tr key={d.id}>
                            <td data-label="Name">
                              {d.name}
                              <br />
                              <small>receipt.v1 → record-receipt.v1</small>
                            </td>
                            <td data-label="State">
                              {d.active ? "Active" : "Inactive"}
                            </td>
                            <td data-label="Revision">{d.revision}</td>
                            <td data-label="Details">
                              <a
                                href={`#automations/${d.id}`}
                                onClick={() => {
                                  setDetail({ kind: "loading" });
                                  setHistory({ kind: "loading" });
                                }}
                              >
                                Open <span className="sr-only">{d.name}</span> →
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted">
                    Showing up to 100 definitions; the API does not provide
                    pagination.
                  </p>
                </>
              )}
            </section>
          )}
        </>
      ) : create ? (
        <>
          <h1>Create Automation</h1>
          <form className="panel" onSubmit={createAutomation} noValidate>
            <label htmlFor="create-scope">Scope (required)</label>
            <input
              id="create-scope"
              ref={scopeInput}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              aria-invalid={!!validation && !validText(scope, 128)}
              aria-describedby={
                validation && !validText(scope, 128)
                  ? "create-error"
                  : undefined
              }
            />
            <label htmlFor="automation-name">Name (required)</label>
            <input
              id="automation-name"
              ref={nameInput}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!validation && !validText(name, 200)}
              aria-describedby={
                validation && !validText(name, 200) ? "create-error" : undefined
              }
            />
            <p>Choose a name that helps operators identify this automation.</p>
            <div className="fixed-definition">
              <p>
                Trigger · fixed
                <br />
                <strong>receipt.v1</strong>
              </p>
              <p>
                Action · fixed
                <br />
                <strong>record-receipt.v1</strong>
              </p>
            </div>
            <h2>Created inactive</h2>
            <p>
              Creation does not activate the automation. Review its details
              before activation.
            </p>
            {validation && (
              <p role="alert" id="create-error">
                {validation}
              </p>
            )}
            {mutationError && <p role="alert">{mutationError}</p>}
            <div className="form-row">
              <button disabled={pending}>
                {pending ? "Creating…" : "Create inactive automation"}
              </button>
              <a href="#automations">Cancel</a>
            </div>
          </form>
        </>
      ) : (
        <>
          <p>
            <a href="#automations">← Automations</a>
          </p>
          <h1>Automation Details</h1>
          {!validId(id) ? (
            <p role="alert">Invalid automation ID.</p>
          ) : detail.kind === "loading" ? (
            <p role="status">Loading automation…</p>
          ) : detail.kind === "error" ? (
            <section className="panel">
              <p role="alert">{detail.message}</p>
              <button onClick={() => reload()}>Reload</button>
            </section>
          ) : (
            <>
              <section className="panel">
                <h2>{detail.data.name}</h2>
                <p>
                  {detail.data.active ? "Active" : "Inactive"} · revision{" "}
                  {detail.data.revision}
                </p>
                <p>Scope: {detail.data.scope}</p>
                {refreshingDetail && (
                  <p role="status">Refreshing automation.</p>
                )}
                <p>
                  Trigger: receipt.v1
                  <br />
                  Action: record-receipt.v1
                </p>
                <button
                  disabled={pending || !!mutationError}
                  onClick={() => toggle(detail.data)}
                >
                  {pending
                    ? "Saving…"
                    : detail.data.active
                      ? "Deactivate"
                      : "Activate"}
                </button>
                {mutationError && (
                  <>
                    <p role="alert">{mutationError}</p>
                    <button
                      onClick={() => {
                        setMutationError("");
                        reload();
                      }}
                    >
                      Reload
                    </button>
                  </>
                )}
              </section>
              <section className="panel" aria-live="polite">
                <h2>Execution history</h2>
                {history.kind === "loading" ? (
                  <p>Loading history…</p>
                ) : history.kind === "error" ? (
                  <>
                    <p role="alert">{history.message}</p>
                    <button disabled={pending} onClick={() => reload()}>
                      Retry
                    </button>
                  </>
                ) : history.data.length === 0 ? (
                  <p>No executions yet.</p>
                ) : (
                  <>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Event</th>
                            <th>Execution status</th>
                            <th>Revision</th>
                            <th>Created · UTC</th>
                            <th>Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.data.map((x) => (
                            <tr key={x.id}>
                              <td data-label="Event">
                                <a
                                  href={`#explorer?eventId=${encodeURIComponent(x.eventId)}`}
                                >
                                  {x.eventId}
                                </a>
                              </td>
                              <td data-label="Execution status">
                                {x.status.replaceAll("_", " ")}
                              </td>
                              <td data-label="Revision">{x.revision}</td>
                              <td data-label="Created · UTC">{x.createdAt}</td>
                              <td data-label="Result">
                                {x.result ? (
                                  <pre>{JSON.stringify(x.result, null, 2)}</pre>
                                ) : (
                                  "Not available"
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="muted">
                      Showing up to 100 executions; the API does not provide
                      pagination or an updated timestamp. Refresh for a current
                      snapshot.
                    </p>
                  </>
                )}
                <button disabled={pending} onClick={() => reload(true)}>
                  Refresh
                </button>
              </section>
              <section className="panel">
                <h2>Revisions</h2>
                <p>
                  Revision history is unavailable from the current API. Current
                  revision: {detail.data.revision}.
                </p>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
