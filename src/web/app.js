import {
  title,
  duration,
  describeTrigger,
  stepTitle,
  renderWorkflow,
} from "./workflow.js";

const element = (id) => document.getElementById(id);
function node(tag, className, text) {
  const value = document.createElement(tag);
  value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}
let versions = [];
let selected = new Set();
let focusedVersionId;
let sandboxId = localStorage.getItem("sandboxId");
let snapshot;
let sandboxLost = false;
let busy = true;
let refreshTask;
let refreshFailed = false;
let report;
let flowSignature = "";
let transcriptSignature = "";
let enabledSignature = "";

async function api(path, body, method = "POST") {
  const response = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : body instanceof FormData
        ? { body }
        : {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }),
  });
  const value = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    const error = new Error(value.error ?? "Request failed");
    error.status = response.status;
    throw error;
  }
  return value;
}

function notice(text, error = false) {
  element("status").textContent = text;
  element("status").classList.toggle("error", error);
}

function action(operation) {
  return async () => {
    if (busy) return;
    busy = true;
    updateControls();
    try {
      await operation();
    } catch (error) {
      notice(error.message, true);
    } finally {
      busy = false;
      updateControls();
    }
  };
}

const selectedIds = () => [...selected];
const conversation = () =>
  snapshot?.conversations.find(
    (value) => value.contactId === element("contact").value,
  );
const focusedVersion = () =>
  versions.find((version) => version.id === focusedVersionId);
const badge = (status) => node("span", `badge ${status}`, title(status));

function updateControls() {
  const ready = Boolean(snapshot && !sandboxLost);
  for (const button of document.querySelectorAll("[data-action]"))
    button.disabled = busy;
  element("new-sandbox").disabled = busy || selected.size === 0;
  for (const kind of ["comment", "message"])
    element(kind).disabled =
      busy ||
      !ready ||
      !element("text").value.trim() ||
      !element("contact").value.trim();
  element("advance").disabled =
    busy || !ready || snapshot.sandbox.mode !== "accelerated";
  element("seconds").disabled =
    busy || !ready || snapshot.sandbox.mode !== "accelerated";
  for (const checkbox of element("enabled").querySelectorAll("input"))
    checkbox.disabled = busy;
  element("stop").disabled = busy || !conversation();
  element("export-workflow").disabled = busy || !focusedVersion();
  element("export-conversation").disabled = busy || !conversation();
  element("backtest").disabled =
    busy || !element("backtest-file").files[0] || selected.size === 0;
  for (const panel of element("invocations").children) {
    const invocation = snapshot?.invocations.find(
      (value) => value.id === panel.id,
    );
    for (const button of panel.querySelectorAll("button"))
      button.disabled =
        busy ||
        !invocation ||
        !["pending", "obsolete"].includes(invocation.status) ||
        Object.hasOwn(invocation, "result") ||
        Boolean(invocation.error);
  }
}

function groups() {
  const grouped = new Map();
  for (const version of [...versions].sort((a, b) => b.version - a.version)) {
    if (!grouped.has(version.key)) grouped.set(version.key, []);
    grouped.get(version.key).push(version);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function chooseVersion(id, checked) {
  if (checked) {
    selected.add(id);
    focusedVersionId = id;
  } else selected.delete(id);
  renderSidebar();
  renderSelection();
  render();
}

function renderSidebar() {
  const all = groups();
  const search = element("search").value.trim().toLowerCase();
  element("workflow-count").textContent = all.length;
  element("workflow-list").replaceChildren(
    ...all
      .filter(([key]) => key.toLowerCase().includes(search))
      .map(([key, values]) => {
        const group = node(
          "div",
          `workflow-group${values.some((value) => selected.has(value.id)) ? " selected" : ""}`,
        );
        const latest = values[0];
        const label = node("label", "workflow-choice");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(latest.id);
        checkbox.onchange = () => chooseVersion(latest.id, checkbox.checked);
        const text = node("span", "");
        const name = node("strong", "", title(key));
        name.title = key;
        text.append(
          name,
          node(
            "small",
            "",
            `v${latest.version} · ${latest.definition.steps.length} steps`,
          ),
        );
        label.append(checkbox, text);
        group.append(label);
        if (values.length > 1) {
          const details = node("details", "");
          details.append(
            node("summary", "", `${values.length - 1} earlier versions`),
          );
          for (const version of values.slice(1)) {
            const label = node("label", "", `Version ${version.version}`);
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = selected.has(version.id);
            checkbox.setAttribute(
              "aria-label",
              `${title(key)} version ${version.version}`,
            );
            checkbox.onchange = () =>
              chooseVersion(version.id, checkbox.checked);
            label.prepend(checkbox);
            details.append(label);
          }
          group.append(details);
        }
        return group;
      }),
  );
  if (!all.length)
    element("workflow-list").append(
      node(
        "p",
        "sidebar-hint",
        "No workflows yet. Upload your first file below.",
      ),
    );
}

function renderSelection() {
  const available = new Set([
    ...selected,
    ...(snapshot?.sandbox.workflowVersionIds ?? []),
  ]);
  const choices = versions.filter((value) => available.has(value.id));
  if (!available.has(focusedVersionId)) focusedVersionId = choices[0]?.id;
  element("workflows").replaceChildren(
    ...choices.map((value) => {
      const option = node(
        "option",
        "",
        `${title(value.key)} · v${value.version}`,
      );
      option.value = value.id;
      option.selected = value.id === focusedVersionId;
      return option;
    }),
  );
  element("progress-workflow").classList.toggle("done", selected.size > 0);
  element("progress-workflow-text").textContent = selected.size
    ? `${selected.size} version${selected.size === 1 ? "" : "s"} selected`
    : "Upload or select a saved version";
  updateControls();
}

async function loadWorkflows(ids) {
  versions = await api("/api/workflows", undefined, "GET");
  if (ids) selected = new Set(ids);
  if (!selected.size && versions.length)
    selected.add(
      versions.findLast((value) => value.key === "pricing")?.id ??
        versions.at(-1).id,
    );
  if (ids?.length) focusedVersionId = ids[0];
  renderSidebar();
  renderSelection();
  render();
}

function setView(view) {
  for (const name of ["conversation", "backtest"]) {
    element(`${name}-view`).hidden = name !== view;
    element(`${name}-tab`).classList.toggle("active", name === view);
    element(`${name}-tab`).setAttribute("aria-pressed", String(name === view));
  }
  element("workspace-name").textContent = title(view);
  element("page-title").textContent =
    view === "conversation"
      ? "See your workflow in action."
      : "Learn from a whole conversation.";
  element("page-description").textContent =
    view === "conversation"
      ? "Follow the steps, act as a contact, and see exactly what happens."
      : "Replay a history safely. See what would be sent, completed, or left waiting.";
}

function renderGuidance() {
  const version = focusedVersion();
  const current = conversation();
  const run = current?.runs.at(-1);
  const accelerated = snapshot?.sandbox.mode === "accelerated";
  const lastDecision = current?.trace.findLast((entry) =>
    ["stopped", "started", "error"].includes(entry.kind),
  );
  let heading = "Start with a workflow";
  let text =
    "Choose a saved version on the left, or upload your workflow file.";
  if (version && (!snapshot || sandboxLost)) {
    heading = sandboxLost
      ? "Your previous sandbox has ended"
      : "Ready to try this workflow?";
    text = `Click New sandbox to test ${title(version.key)}. A sandbox keeps test messages separate; nothing is sent to a real contact.`;
  } else if (
    version &&
    !snapshot.sandbox.workflowVersionIds.includes(version.id)
  ) {
    heading = "This selection is for your next sandbox";
    text =
      "Click New sandbox to use it. The current conversation below keeps its enabled workflow versions.";
  } else if (current?.status === "failed") {
    heading = "Conversation history limit reached";
    text =
      "This conversation stays stopped until you click Restart conversation. Restarting creates a fresh working context; recorded history remains visible.";
  } else if (lastDecision?.kind === "stopped" || run?.status === "stopped") {
    heading = "Conversation stopped";
    text =
      "Future work was cleared. A genuinely new matching comment or message can start another run.";
  } else if (
    run?.status === "failed" ||
    (run?.status === "timed_out" && run.error)
  ) {
    heading =
      run.status === "timed_out"
        ? "The conversation is paused after a call timed out"
        : "The conversation is paused after a failure";
    text =
      "Use Stop conversation to clear the backlog before trying a new trigger. Details are shown in the agent response or trace.";
  } else if (run?.status === "preparing") {
    heading = "An agent response is on hold";
    text =
      "Supply the mock response below and click Complete. Or add another message to see the older response become obsolete.";
  } else if (run?.status === "waiting") {
    const step = versions
      .find((value) => value.id === run.workflowVersionId)
      ?.definition.steps.find((step) => step.id === run.stepId);
    heading =
      step?.kind === "wait_message" && step.accept.op === "is_email"
        ? "Waiting for the contact’s email"
        : "Waiting for a reply";
    text =
      step?.kind === "wait_message" && step.accept.op === "is_email"
        ? `Try “hello” to see an invalid reply, then send “person@example.com” as a Message. ${accelerated ? "Advance time to continue." : "Replies are processed automatically after a short quiet window."}`
        : `Reply as the contact using Message. ${accelerated ? "Advance the clock to test the wait timeout." : "Replies and timeouts are processed in real time."}`;
  } else if (
    current?.pending.length ||
    (current?.nextAt && current.nextAt > snapshot.now && !run)
  ) {
    heading = "Collecting messages before answering";
    text = `The workflow waits for a 3-second quiet window so it can read messages together. ${accelerated ? "Click Advance time to see the reply." : "The reply will appear automatically."}`;
  } else if (run?.status === "completed") {
    heading = "The workflow completed";
    text =
      "All required steps finished. Try another trigger, change the contact, or create a New sandbox for a fresh test.";
  } else if (run?.status === "timed_out") {
    heading = "The wait timed out";
    text =
      "The contact did not reply before the deadline. You can try a new trigger to start another run.";
  } else if (version && snapshot) {
    heading = `Start with ${version.definition.trigger.kind === "comment" ? "a comment" : "a private message"}`;
    text = `${describeTrigger(version.definition)} starts this workflow. Write “${version.definition.trigger.value ?? "your message"}” below, then use ${version.definition.trigger.kind === "comment" ? "Comment" : "Message"}.`;
  }
  const copy = node("div", "");
  copy.append(node("strong", "", heading), node("p", "", text));
  element("next-action").replaceChildren(node("span", "next-icon", "→"), copy);
}

function renderTranscript(current) {
  const entries =
    current?.trace.filter((entry) =>
      ["input", "delivered"].includes(entry.kind),
    ) ?? [];
  const signature = `${current?.id}:${entries.length}`;
  if (signature === transcriptSignature) return;
  transcriptSignature = signature;
  const list = element("transcript");
  const nearBottom =
    list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.replaceChildren(
    ...entries.map((entry) => {
      const outgoing = entry.kind === "delivered";
      const parts = /^(comment|message):\s?([\s\S]*)$/.exec(entry.text);
      const message = node("li", `chat-message${outgoing ? " outgoing" : ""}`);
      const meta = node("div", "chat-meta");
      meta.append(
        node("span", "", outgoing ? "Automation" : "Contact"),
        node(
          "span",
          "channel",
          parts?.[1] === "comment" ? "Public comment" : "Private message",
        ),
      );
      const time = node(
        "time",
        "",
        new Date(entry.at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
      time.dateTime = new Date(entry.at).toISOString();
      meta.append(time);
      message.append(
        meta,
        node("div", "chat-bubble", parts?.[2] ?? entry.text),
      );
      return message;
    }),
  );
  if (!entries.length) {
    const empty = node("li", "empty-chat");
    empty.append(
      node("span", "", "◌"),
      node("strong", "", "Your conversation starts here"),
      node(
        "p",
        "",
        "Send the trigger shown in the workflow. Outgoing replies will appear here.",
      ),
    );
    list.append(empty);
  }
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function createInvocation(invocation) {
  const panel = node("fieldset", "invocation");
  panel.id = invocation.id;
  panel.append(
    node(
      "legend",
      "",
      invocation.callKind === "classifier"
        ? "Mock classifier"
        : "Mock agent response",
    ),
  );
  const heading = node("div", "invocation-title");
  heading.append(
    node("strong", "", `Response ${invocation.attempt}`),
    badge(invocation.status),
  );
  panel.append(heading, node("p", "invocation-help"));
  const schema = invocation.resultSchema;
  const textResult =
    schema.type === "object" &&
    schema.properties?.text?.type === "string" &&
    (schema.required ?? []).every((key) => key === "text");
  const simple =
    invocation.callKind === "classifier" ||
    schema.type === "string" ||
    textResult;
  const editor = document.createElement(
    invocation.callKind === "classifier" ? "select" : "textarea",
  );
  editor.dataset.editor = "";
  editor.dataset.format =
    invocation.callKind === "classifier" || schema.type === "string"
      ? "string"
      : textResult
        ? "text"
        : "json";
  editor.setAttribute(
    "aria-label",
    invocation.callKind === "classifier"
      ? "Classifier decision"
      : simple
        ? "Controlled response"
        : "Controlled JSON result",
  );
  if (invocation.callKind === "classifier") {
    for (const [value, label] of [
      ["continue", "Continue automation"],
      ["stop", "Stop conversation"],
    ]) {
      const option = node("option", "", label);
      option.value = value;
      editor.append(option);
    }
  } else {
    editor.value = simple ? "" : "{}";
    editor.placeholder = simple
      ? "Write the response the agent should return…"
      : "Enter a JSON result matching the schema below";
  }
  const label = node(
    "label",
    "",
    simple ? "Controlled response" : "Controlled JSON result",
  );
  label.append(editor);
  panel.append(label);
  if (simple && invocation.callKind !== "classifier") {
    const label = node("label", "", " Edit JSON");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.onchange = () => {
      try {
        if (checkbox.checked) {
          editor.value = JSON.stringify(
            editor.dataset.format === "text"
              ? { text: editor.value }
              : editor.value,
            null,
            2,
          );
          editor.dataset.format = "json";
        } else {
          const result = JSON.parse(editor.value);
          const value = textResult ? result.text : result;
          if (typeof value !== "string")
            throw new Error("Use a text response before switching back.");
          editor.value = value;
          editor.dataset.format = textResult ? "text" : "string";
        }
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        notice(error.message, true);
      }
    };
    label.prepend(checkbox);
    panel.append(label);
  }
  const controls = node("div", "invocation-controls");
  for (const [name, failed] of [
    ["Complete", false],
    ["Fail", true],
  ]) {
    const button = node(
      "button",
      `button ${failed ? "secondary" : "primary"}`,
      name,
    );
    button.dataset.action = "";
    button.onclick = action(async () => {
      const completion = failed
        ? { error: "Controlled failure" }
        : {
            result:
              editor.dataset.format === "json"
                ? JSON.parse(editor.value)
                : editor.dataset.format === "text"
                  ? { text: editor.value }
                  : editor.value,
          };
      await api(
        `/api/sandboxes/${sandboxId}/invocations/${encodeURIComponent(invocation.id)}`,
        completion,
      );
      await refresh();
      notice(
        failed
          ? "Failure recorded. Stop the conversation to clear its paused backlog."
          : "Controlled response recorded. Check the conversation for the result.",
      );
    });
    controls.append(button);
  }
  const details = node("details", "");
  details.append(
    node("summary", "", "Context & expected result"),
    node("pre", ""),
  );
  panel.append(controls, node("div", "invocation-result"), details);
  return panel;
}

function renderInvocations(current) {
  const list = element("invocations");
  const invocations = current?.invocations ?? [];
  const existing = new Map(
    [...list.children].map((panel) => [panel.id, panel]),
  );
  for (const [index, invocation] of invocations.entries()) {
    const panel = existing.get(invocation.id) ?? createInvocation(invocation);
    // Keep editor nodes mounted so polling cannot erase drafts or move the caret.
    if (list.children[index] !== panel)
      list.insertBefore(panel, list.children[index] ?? null);
    panel.querySelector(".badge").replaceWith(badge(invocation.status));
    const history = invocation.input?.history ?? [];
    panel.querySelector(".invocation-help").textContent =
      invocation.status === "obsolete"
        ? "A newer message or stop replaced this response. A late completion is recorded but cannot send."
        : invocation.status === "pending"
          ? `No model is called. This response has ${history.length} contact message${history.length === 1 ? "" : "s"} in context. Supply a result to continue.`
          : invocation.status === "accepted"
            ? "The result was accepted. The workflow can use it for the next step."
            : (invocation.error ?? "This call timed out.");
    panel.querySelector("pre").textContent = JSON.stringify(
      {
        input: invocation.input,
        result: invocation.result,
        error: invocation.error,
        revision: invocation.revision,
        resultSchema: invocation.resultSchema,
      },
      null,
      2,
    );
    panel.querySelector(".invocation-result").textContent = Object.hasOwn(
      invocation,
      "result",
    )
      ? `Recorded result: ${typeof invocation.result === "string" ? invocation.result : JSON.stringify(invocation.result)}`
      : "";
    existing.delete(invocation.id);
  }
  for (const panel of existing.values()) panel.remove();
}

function render() {
  const version = focusedVersion();
  const current = conversation();
  element("restart").hidden = current?.status !== "failed";
  element("stop").hidden = current?.status === "failed";
  const run = current?.runs.at(-1);
  const matchingRun = current?.runs.findLast(
    (value) => value.workflowVersionId === version?.id,
  );
  const signature = JSON.stringify([
    version?.id,
    matchingRun,
    current?.pending,
  ]);
  element("workflow-title").textContent = version
    ? title(version.key)
    : "No workflow selected";
  if (signature !== flowSignature) {
    flowSignature = signature;
    renderWorkflow(
      element("steps"),
      version,
      matchingRun,
      current?.pending.some((value) => value.workflowVersionId === version?.id),
    );
  }
  const summary = element("runs");
  summary.replaceChildren();
  if (run) {
    const definition = versions.find(
      (version) => version.id === run.workflowVersionId,
    );
    const step = definition?.definition.steps.find(
      (step) => step.id === run.stepId,
    );
    summary.append(
      badge(run.status),
      node(
        "span",
        "",
        `${title(definition?.key ?? "Workflow")} · ${step ? stepTitle(step) : ""}`,
      ),
    );
  } else
    summary.append(
      node(
        "span",
        "",
        current?.pending.length
          ? "Trigger received · collecting messages"
          : "No active run yet",
      ),
    );
  renderTranscript(current);
  renderInvocations(current);
  renderGuidance();
  element("progress-sandbox").classList.toggle("done", Boolean(snapshot));
  element("progress-sandbox-text").textContent = snapshot
    ? "Ready · messages are simulated"
    : "Create an isolated test conversation";
  element("progress-conversation").classList.toggle(
    "done",
    Boolean(current?.events.length),
  );
  element("sandbox").textContent = snapshot
    ? `${title(snapshot.sandbox.mode)} sandbox · ${new Date(snapshot.now).toLocaleTimeString()}`
    : sandboxLost
      ? "Previous accelerated sandbox ended"
      : "No sandbox yet";
  element("clock-hint").textContent =
    snapshot?.sandbox.mode === "normal"
      ? "Normal execution uses real time. Manual time controls are disabled."
      : "Advance 3.1 seconds after sending input to pass the quiet window. Larger values test wait timeouts.";
  element("composer-hint").textContent = snapshot
    ? "Comment is public. Message is a private reply."
    : "Create a sandbox to send your first message.";
  const enabled = snapshot?.sandbox.workflowVersionIds ?? [];
  element("enabled-count").textContent = snapshot ? `(${enabled.length})` : "";
  const enabledKey = JSON.stringify([
    snapshot?.sandbox.id,
    enabled,
    versions.length,
  ]);
  if (enabledKey !== enabledSignature) {
    enabledSignature = enabledKey;
    element("enabled").replaceChildren(
      ...(snapshot
        ? versions.map((version) => {
            const label = node(
              "label",
              "",
              `${title(version.key)} · v${version.version}`,
            );
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = enabled.includes(version.id);
            checkbox.onchange = action(async () => {
              const next = checkbox.checked;
              checkbox.checked = enabled.includes(version.id);
              await api(
                `/api/sandboxes/${sandboxId}/workflows/${version.id}`,
                { enabled: next },
                "PATCH",
              );
              await refresh();
              renderSelection();
            });
            label.prepend(checkbox);
            return label;
          })
        : [node("p", "", "Create a sandbox to manage enabled versions.")]),
    );
  }
  element("actions").replaceChildren(
    ...(current?.actions ?? []).map((entry) =>
      node(
        "li",
        "",
        `${entry.channel === "comment" ? "Public reply" : "Private message"} · ${title(entry.status)} · ${entry.text}`,
      ),
    ),
  );
  element("trace").replaceChildren(
    ...(current?.trace ?? []).map((entry) =>
      node(
        "li",
        "",
        `${new Date(entry.at).toLocaleTimeString()} · ${entry.kind} · ${entry.text}`,
      ),
    ),
  );
  element("snapshot-json").textContent = snapshot
    ? JSON.stringify(snapshot, null, 2)
    : "No active sandbox";
  updateControls();
}

function refresh() {
  if (!sandboxId || sandboxLost) return Promise.resolve();
  const id = sandboxId;
  if (refreshTask?.id === id) return refreshTask.promise;
  const promise = api(`/api/sandboxes/${id}`, undefined, "GET")
    .then((value) => {
      if (sandboxId !== id) return;
      const firstSnapshot = !snapshot;
      snapshot = value;
      if (firstSnapshot) renderSelection();
      render();
      if (refreshFailed) notice("Connection restored. Your sandbox is ready.");
      refreshFailed = false;
    })
    .catch((error) => {
      if (sandboxId !== id) return;
      refreshFailed = true;
      if (
        error.status === 400 &&
        error.message ===
          "Accelerated sandbox is no longer running; create a new sandbox"
      ) {
        sandboxLost = true;
        snapshot = undefined;
        render();
      }
      throw error;
    })
    .finally(() => {
      if (refreshTask?.promise === promise) refreshTask = undefined;
    });
  refreshTask = { id, promise };
  return promise;
}

function showReport(value) {
  report = value;
  const heading = node("header", "panel-heading");
  const label = node("div", "");
  label.append(
    node("span", "eyebrow", "SAVED REPORT"),
    node("h2", "", "Your backtest results"),
  );
  heading.append(label, node("span", "badge completed", "Saved"));
  const stats = node("dl", "report-stats");
  for (const [name, count] of [
    ["Events received", value.events],
    ["Messages sent", value.messages.length],
    ["Completed runs", value.completed],
  ]) {
    const stat = node("div", "");
    stat.append(node("dt", "", name), node("dd", "", count));
    stats.append(stat);
  }
  const summary = node("div", "report-summary");
  const waiting = value.runs.filter((run) =>
    ["waiting", "preparing", "running", "sending"].includes(run.status),
  ).length;
  summary.append(
    node(
      "p",
      "",
      `${waiting} still active at the cutoff · ${value.stopped} stopped · ${value.timedOut} timed out · ${value.duplicates} duplicate events`,
    ),
  );
  for (const error of value.errors) summary.append(node("p", "", error));
  const details = node("details", "");
  details.append(
    node("summary", "", "Report data & ID"),
    node("pre", "", JSON.stringify(value, null, 2)),
  );
  summary.append(details);
  element("report").replaceChildren(heading, stats, summary);
  const messages = element("report-messages");
  messages.hidden = false;
  messages.replaceChildren(node("h2", "", "Messages the automation sent"));
  for (const message of value.messages) {
    const item = node("div", "report-message");
    item.append(
      node(
        "small",
        "",
        `${message.contactId} · ${message.channel === "comment" ? "Public reply" : "Private message"}`,
      ),
      node("span", "", message.text),
    );
    messages.append(item);
  }
  if (!value.messages.length)
    messages.append(
      node("p", "", "No messages were delivered before the cutoff."),
    );
  element("report-trace").replaceChildren(
    ...value.trace.map((entry) =>
      node("li", "", `${entry.conversationId} · ${entry.kind} · ${entry.text}`),
    ),
  );
}

for (const view of ["conversation", "backtest"])
  element(`${view}-tab`).onclick = () => setView(view);
function closeMenu() {
  document.querySelector(".app-shell").classList.remove("sidebar-open");
  element("menu").setAttribute("aria-expanded", "false");
}
element("close-menu").onclick = () => {
  closeMenu();
  element("menu").focus();
};
element("menu").onclick = () => {
  const open = document
    .querySelector(".app-shell")
    .classList.toggle("sidebar-open");
  element("menu").setAttribute("aria-expanded", String(open));
  if (open) element("close-menu").focus();
};
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    document.querySelector(".app-shell").classList.contains("sidebar-open")
  ) {
    closeMenu();
    element("menu").focus();
  }
});
element("search").oninput = renderSidebar;
element("workflows").onchange = () => {
  focusedVersionId = element("workflows").value;
  render();
};
element("contact").oninput = render;
element("text").oninput = updateControls;
async function download(path, filename) {
  const response = await fetch(path);
  if (!response.ok)
    throw new Error((await response.json()).error ?? "Download failed");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
element("export-workflow").onclick = action(async () => {
  const version = focusedVersion();
  await download(
    `/api/workflows/${encodeURIComponent(version.id)}/export`,
    `${version.key}-v${version.version}.json`,
  );
  notice(
    "Workflow downloaded. You can edit the JSON and upload it as a new version.",
  );
});
element("export-conversation").onclick = action(async () => {
  await download(
    `/api/sandboxes/${sandboxId}/conversations/${encodeURIComponent(conversation().id)}/export`,
    "conversation.json",
  );
  notice(
    "Conversation downloaded. Open Backtest and upload this file to try your selected workflows.",
  );
});
element("upload").onclick = action(async () => {
  const file = element("workflow-file").files[0];
  if (!file) throw new Error("Choose a JSON or YAML workflow file first.");
  const body = new FormData();
  body.append("file", file);
  const version = await api("/api/workflows", body);
  await loadWorkflows([version.id]);
  notice(
    `${title(version.key)} v${version.version} uploaded. Click New sandbox to try it.`,
  );
});
element("new-sandbox").onclick = action(async () => {
  const sandbox = await api("/api/sandboxes", {
    workflowVersionIds: selectedIds(),
  });
  sandboxId = sandbox.id;
  sandboxLost = false;
  snapshot = undefined;
  localStorage.setItem("sandboxId", sandboxId);
  setView("conversation");
  await refresh();
  renderSelection();
  closeMenu();
  notice("Sandbox ready. Follow the next action below to try your workflow.");
});
for (const kind of ["comment", "message"])
  element(kind).onclick = action(async () => {
    const text = element("text").value;
    await api(`/api/sandboxes/${sandboxId}/events`, {
      eventId: crypto.randomUUID(),
      ...(kind === "comment" ? { commentId: crypto.randomUUID() } : {}),
      accountId: "demo-account",
      contactId: element("contact").value,
      kind,
      text,
    });
    if (element("text").value === text) element("text").value = "";
    await refresh();
    notice(
      snapshot?.sandbox.mode === "normal"
        ? "Contact input received. Processing continues automatically after the quiet window."
        : "Contact input received. Advance time to pass the quiet window, then watch the conversation.",
    );
  });
element("advance").onclick = action(async () => {
  const seconds = Number(element("seconds").value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400)
    throw new Error("Choose a time between 0 and 86,400 seconds.");
  snapshot = await api(`/api/sandboxes/${sandboxId}/time`, {
    milliseconds: Math.round(seconds * 1000),
  });
  render();
  notice(`Advanced the sandbox clock by ${duration(seconds * 1000)}.`);
});
element("stop").onclick = action(async () => {
  await api(
    `/api/sandboxes/${sandboxId}/conversations/${encodeURIComponent(conversation().id)}/stop`,
    {},
  );
  await refresh();
  notice(
    "Conversation stopped. Future work was cleared; a new trigger can start again.",
  );
});
element("restart").onclick = action(async () => {
  await api(
    `/api/sandboxes/${sandboxId}/conversations/${encodeURIComponent(conversation().id)}/restart`,
    {},
  );
  await refresh();
  notice("Conversation restarted. Send a new trigger to begin.");
});
element("backtest-file").onchange = async () => {
  try {
    const file = element("backtest-file").files[0];
    element("backtest-preview").replaceChildren();
    if (file) {
      const input = JSON.parse(await file.text());
      const list = node("ol", "");
      for (const entry of input.timeline.slice(0, 5))
        list.append(
          node(
            "li",
            "",
            `${duration(entry.at)} · ${entry.kind === "event" ? `${entry.event.contactId}: ${entry.event.text}` : "Controlled agent result"}`,
          ),
        );
      element("backtest-preview").append(
        node(
          "strong",
          "",
          `${input.timeline.length} entries · cutoff ${duration(input.until)}`,
        ),
        list,
      );
    }
  } catch (error) {
    notice(error.message, true);
  }
  updateControls();
};
element("backtest").onclick = action(async () => {
  const input = JSON.parse(await element("backtest-file").files[0].text());
  input.workflowVersionIds = selectedIds();
  const value = await api("/api/backtests", input);
  showReport(value);
  localStorage.setItem("backtestId", value.id);
  notice("Backtest saved. Read the results and messages below.");
});

async function initialize() {
  try {
    await loadWorkflows();
    const savedReport = localStorage.getItem("backtestId");
    const results = await Promise.allSettled([
      refresh(),
      savedReport
        ? api(`/api/backtests/${savedReport}`, undefined, "GET").then(
            showReport,
          )
        : Promise.resolve(),
    ]);
    if (snapshot) {
      selected = new Set(snapshot.sandbox.workflowVersionIds);
      renderSidebar();
      renderSelection();
      render();
    }
    if (!snapshot && report) setView("backtest");
    if (sandboxLost)
      notice(
        "Your previous accelerated sandbox ended. Create a New sandbox to continue. Saved reports remain available.",
      );
    else if (results[0].status === "rejected")
      notice(results[0].reason.message, true);
    else if (results[1].status === "rejected")
      notice(
        "Your saved report could not be loaded. You can run another backtest.",
        true,
      );
    else
      notice(
        snapshot
          ? "Your sandbox is ready. Follow the next action below."
          : "Choose a workflow to begin. All messages stay inside this demo.",
      );
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    updateControls();
  }
}
void initialize();
setInterval(() => {
  if (!busy && !sandboxLost)
    void refresh().catch((error) => notice(error.message, true));
}, 500);
