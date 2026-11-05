export function title(value) {
  const text = value.replaceAll("_", " ").replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function duration(milliseconds) {
  if (milliseconds >= 60000 && milliseconds % 60000 === 0)
    return `${milliseconds / 60000} min`;
  return `${Math.round(milliseconds / 100) / 10} sec`;
}

export function describePredicate(predicate) {
  if (predicate.op === "is_email") return "is a valid email address";
  return `${predicate.op === "equals" ? "is" : "contains"} “${predicate.value ?? ""}”`;
}

export function describeTrigger(definition) {
  return `${definition.trigger.kind === "comment" ? "A comment" : "A private message"} ${describePredicate(definition.trigger)}`;
}

export function stepTitle(step) {
  switch (step.kind) {
    case "reply_comment":
      return "Reply to the comment";
    case "send_message":
      return "Send a private message";
    case "condition":
      return "Check a condition";
    case "wait_message":
      return step.accept.op === "is_email"
        ? "Wait for an email"
        : "Wait for a message";
    case "agent_call":
      return "Prepare an agent response";
    case "end":
      return "Finish the workflow";
  }
}

function nextSteps(step) {
  if (step.kind === "end") return [];
  if (step.kind === "condition")
    return [
      { id: step.then, label: "Yes" },
      { id: step.else, label: "No" },
    ];
  if (step.kind === "wait_message")
    return [
      { id: step.next, label: "Reply" },
      { id: step.onTimeout, label: "Timeout" },
    ];
  return [{ id: step.next, label: "" }];
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const icons = {
  trigger: "ϟ",
  reply_comment: "↩",
  send_message: "↗",
  condition: "◇",
  wait_message: "◷",
  agent_call: "✧",
  end: "✓",
};
let observer;

export function renderWorkflow(container, version, run, pending) {
  observer?.disconnect();
  container.replaceChildren();
  if (!version) {
    const empty = element("div", "empty-chat");
    empty.append(
      element("span", "", "◇"),
      element("strong", "", "Choose a workflow to see its steps"),
      element(
        "p",
        "",
        "Upload JSON or YAML, or select a saved workflow from the sidebar.",
      ),
    );
    container.append(empty);
    return;
  }
  const definition = version.definition;
  const steps = new Map(definition.steps.map((step) => [step.id, step]));
  const levels = new Map([["__trigger", 0]]);
  function place(id, level) {
    if ((levels.get(id) ?? -1) >= level) return;
    levels.set(id, level);
    for (const next of nextSteps(steps.get(id))) place(next.id, level + 1);
  }
  // Uploaded graphs are already acyclic; depth is layout data, never execution state.
  place(definition.start, 1);
  let last = Math.max(...levels.values()) + 1;
  for (const step of definition.steps)
    if (!levels.has(step.id)) levels.set(step.id, last++);
  const content = element("div", "flow-content");
  const cards = new Map();
  const entries = [{ id: "__trigger", kind: "trigger" }, ...definition.steps];
  for (const level of [...new Set(levels.values())].sort((a, b) => a - b)) {
    const row = element("div", "flow-row");
    for (const step of entries.filter(
      (entry) => levels.get(entry.id) === level,
    )) {
      const card = element("article", "flow-node");
      card.dataset.kind = step.kind;
      const header = element("div", "flow-node-header");
      header.append(
        element("span", "node-icon", icons[step.kind]),
        element(
          "strong",
          "flow-node-title",
          step.kind === "trigger" ? "When this happens" : stepTitle(step),
        ),
      );
      card.append(header);
      let description;
      switch (step.kind) {
        case "trigger":
          description = describeTrigger(definition);
          break;
        case "reply_comment":
        case "send_message":
          description = step.text
            .replace(/\{\{steps\.(.*?)\.text\}\}/g, "{captured $1}")
            .replaceAll("{{event.text}}", "{trigger text}");
          break;
        case "wait_message":
          description = `Reply ${describePredicate(step.accept)} · up to ${duration(step.timeoutMs)}`;
          break;
        case "condition":
          description = `${step.path.startsWith("steps.") ? "Captured text" : "Trigger text"} ${describePredicate(step)}`;
          break;
        case "agent_call":
          description =
            "Uses the conversation so far. Supply a mock response to continue.";
          break;
        case "end":
          description =
            "This run is finished. A new trigger can start another.";
          break;
      }
      card.append(element("p", "", description));
      const current =
        step.kind === "trigger"
          ? pending
          : run?.stepId === step.id &&
            !["completed", "timed_out", "stopped", "failed"].includes(
              run.status,
            );
      if (current) {
        card.setAttribute("aria-current", "step");
        card.append(
          element(
            "span",
            "node-current",
            step.kind === "trigger"
              ? "Trigger received · collecting messages"
              : "Current step",
          ),
        );
      }
      if (
        run?.stepId === step.id &&
        step.kind === "end" &&
        !run.error &&
        ["completed", "timed_out"].includes(run.status)
      )
        card.classList.add("is-completed");
      const result = run?.steps[step.id];
      if (
        result &&
        typeof result === "object" &&
        typeof result.text === "string"
      )
        card.append(
          element(
            "p",
            "node-output",
            `${step.kind === "wait_message" ? "Captured" : "Result"}: ${result.text}`,
          ),
        );
      cards.set(step.id, card);
      row.append(card);
    }
    content.append(row);
  }
  const edges = [
    { from: "__trigger", id: definition.start, label: "" },
    ...definition.steps.flatMap((step) =>
      nextSteps(step).map((next) => ({ from: step.id, ...next })),
    ),
  ];
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.classList.add("flow-connections");
  svg.setAttribute("aria-hidden", "true");
  content.prepend(svg);
  container.append(content);
  function draw() {
    const bounds = content.getBoundingClientRect();
    if (!bounds.width) return;
    svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
    svg.replaceChildren();
    const defs = document.createElementNS(namespace, "defs");
    const marker = document.createElementNS(namespace, "marker");
    for (const [key, value] of Object.entries({
      id: "flow-arrow",
      markerWidth: "6",
      markerHeight: "6",
      refX: "5",
      refY: "3",
      orient: "auto",
    }))
      marker.setAttribute(key, value);
    const arrow = document.createElementNS(namespace, "path");
    arrow.setAttribute("d", "M 0 0 L 6 3 L 0 6 Z");
    marker.append(arrow);
    defs.append(marker);
    svg.append(defs);
    for (const edge of edges) {
      const from = cards.get(edge.from).getBoundingClientRect();
      const to = cards.get(edge.id).getBoundingClientRect();
      const x1 = from.left + from.width / 2 - bounds.left;
      const x2 = to.left + to.width / 2 - bounds.left;
      const y1 = from.bottom - bounds.top;
      const y2 = to.top - bounds.top - 3;
      const middle = (y1 + y2) / 2;
      const skip = levels.get(edge.id) - levels.get(edge.from) > 1;
      const lane = Math.min(
        bounds.width - 10,
        Math.max(from.right, to.right) - bounds.left + 17,
      );
      const path = document.createElementNS(namespace, "path");
      path.setAttribute(
        "d",
        skip
          ? `M ${x1} ${y1} V ${y1 + 15} H ${lane} V ${y2 - 13} H ${x2} V ${y2}`
          : `M ${x1} ${y1} C ${x1} ${middle} ${x2} ${middle} ${x2} ${y2}`,
      );
      path.setAttribute("marker-end", "url(#flow-arrow)");
      svg.append(path);
      if (edge.label) {
        const text = document.createElementNS(namespace, "text");
        text.setAttribute("x", String(skip ? lane - 8 : (x1 + x2) / 2));
        text.setAttribute("y", String(skip ? y2 - 18 : middle - 4));
        text.textContent = edge.label;
        svg.append(text);
      }
    }
  }
  observer = new ResizeObserver(draw);
  observer.observe(content);
  requestAnimationFrame(draw);
}
