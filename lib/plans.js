// Plan (task assignment) registry. Append-only event log; projection is rebuilt
// on startup. A plan card is a chat message of type "plan" whose body holds
// only { plan_id }. Dispatch messages are ordinary chat, sent through the
// shared sendMessage() path, never by this module directly.

import crypto from "node:crypto";
import { createRegistry } from "./registry.js";
import { IDENTITY_RE, PLAN_ID_RE } from "./protocol.js";

const MAX_STEPS = 6;
const STEP_TIMEOUT_MS = 10 * 60 * 1000;
const DISPATCHING_STALE_MS = 30 * 1000;

function planId() {
  return `p-${crypto.randomBytes(4).toString("hex")}`;
}

function stepOf(plan, n) {
  return plan.steps.find((s) => s.n === n) ?? null;
}

function currentStep(plan) {
  return plan.steps.find((s) => s.status === "waiting" || s.status === "running") ?? null;
}

function reducePlan(map, record) {
  if (!record || !PLAN_ID_RE.test(record.plan_id ?? "")) return;
  const op = record.op;
  if (op === "create") {
    const plan = {
      ...record.plan,
      plan_id: record.plan_id,
      status: "pending",
      steps: (record.plan.steps ?? []).map((s) => ({
        ...s,
        status: "pending",
        attempt: 0,
        dispatch_message_id: null,
        deadline_ts: null,
        reply_message_id: null,
        file_ids: [],
      })),
      created_at: record.ts,
      updated_at: record.ts,
    };
    map.set(record.plan_id, plan);
    return;
  }
  const plan = map.get(record.plan_id);
  if (!plan) return;
  plan.updated_at = record.ts;
  switch (op) {
    case "start":
      if (plan.status === "pending") plan.status = "running";
      break;
    case "step_start": {
      const step = stepOf(plan, record.step);
      if (!step) break;
      // A "next" dispatch follows a paused plan; make the projection active
      // again so observe() can accept the step's reply.
      if (plan.status !== "stopped" && plan.status !== "done") plan.status = "running";
      step.status = "running";
      step.attempt = record.attempt ?? (step.attempt ?? 0) + 1;
      step.dispatch_message_id = record.dispatch_message_id ?? null;
      step.deadline_ts = record.deadline_ts ?? null;
      break;
    }
    case "step_done": {
      const step = stepOf(plan, record.step);
      if (!step) break;
      step.status = "done";
      step.reply_message_id = record.reply_message_id ?? null;
      if (Array.isArray(record.file_ids)) step.file_ids = [...new Set([...step.file_ids, ...record.file_ids])];
      plan.status = step.n === plan.steps.length ? "done" : "paused";
      break;
    }
    case "step_failed": {
      const step = stepOf(plan, record.step);
      if (!step) break;
      step.status = "failed";
      step.error = record.error ?? null;
      plan.status = "failed";
      break;
    }
    case "step_retry": {
      const step = stepOf(plan, record.step);
      if (!step) break;
      // attempt is bumped by step_start on the new dispatch, not here.
      step.status = "pending";
      step.error = null;
      plan.status = "running";
      break;
    }
    case "assign": {
      const step = stepOf(plan, record.step);
      if (!step || step.status !== "pending") break;
      step.assignee = record.assignee;
      break;
    }
    case "card":
      plan.card_message_id = record.card_message_id ?? null;
      break;
    case "stop":
      plan.status = "stopped";
      break;
    case "done":
      plan.status = "done";
      break;
    default:
      break;
  }
}

export function createPlanRegistry({
  file,
  now = () => new Date().toISOString(),
  logger = console,
  timeoutMs = STEP_TIMEOUT_MS,
} = {}) {
  const registry = createRegistry({
    file,
    key: (r) => (PLAN_ID_RE.test(r?.plan_id ?? "") ? r.plan_id : null),
    reduce: reducePlan,
    now,
    logger,
  });

  function validateCreate(input) {
    if (!input || typeof input !== "object") throw Object.assign(new Error("plan must be an object"), { code: "BAD_INPUT" });
    if (typeof input.title !== "string" || input.title.length === 0 || input.title.length > 80) {
      throw Object.assign(new Error("invalid title"), { code: "BAD_INPUT" });
    }
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > MAX_STEPS) {
      throw Object.assign(new Error(`steps must be 1..${MAX_STEPS}`), { code: "BAD_INPUT" });
    }
    for (const [i, step] of input.steps.entries()) {
      if (!IDENTITY_RE.test(step.assignee ?? "")) throw Object.assign(new Error(`step ${i + 1}: invalid assignee`), { code: "BAD_INPUT" });
      if (typeof step.task !== "string" || step.task.length === 0 || step.task.length > 200) {
        throw Object.assign(new Error(`step ${i + 1}: invalid task`), { code: "BAD_INPUT" });
      }
    }
    if (typeof input.group !== "string" || input.group.length === 0 || input.group.length > 32) {
      throw Object.assign(new Error("invalid group"), { code: "BAD_INPUT" });
    }
  }

  return {
    get file() { return registry.file; },
    get size() { return registry.size; },
    get stats() { return registry.stats; },
    all() { return registry.all(); },
    get(id) { return registry.get(id); },
    has(id) { return registry.has(id); },

    create(input) {
      validateCreate(input);
      const id = planId();
      const plan = {
        plan_id: id,
        group: input.group,
        title: input.title,
        created_by: input.created_by ?? "system",
        steps: input.steps.map((s, i) => ({ n: i + 1, assignee: s.assignee, task: s.task })),
        auto_handoff: Boolean(input.auto_handoff),
        card_message_id: null,
        status: "pending",
      };
      registry.append({ op: "create", plan_id: id, plan });
      return registry.get(id);
    },

    start(id) {
      const plan = registry.get(id);
      if (!plan) throw Object.assign(new Error("plan not found"), { code: "NOT_FOUND" });
      if (plan.status !== "pending") throw Object.assign(new Error("plan already started"), { code: "CONFLICT" });
      registry.append({ op: "start", plan_id: id });
      return registry.get(id);
    },

    updateCard(id, cardMessageId) {
      const plan = registry.get(id);
      if (!plan) throw Object.assign(new Error("plan not found"), { code: "NOT_FOUND" });
      registry.append({ op: "card", plan_id: id, card_message_id: cardMessageId });
      return registry.get(id);
    },

    // Hub calls this AFTER the dispatch chat message has been persisted.
    // Each dispatch bumps the attempt, so late replies to an older dispatch
    // can never complete a newer attempt.
    markStepStart(id, step, dispatchMessageId) {
      const plan = registry.get(id);
      if (!plan) return null;
      const target = stepOf(plan, step);
      const attempt = (target?.attempt ?? 0) + 1;
      const deadline = new Date(Date.now() + timeoutMs).toISOString();
      registry.append({
        op: "step_start",
        plan_id: id,
        step,
        attempt,
        dispatch_message_id: dispatchMessageId,
        deadline_ts: deadline,
      });
      return registry.get(id);
    },

    // Observe a newly persisted chat message. Only a genuine reply from the
    // assignee to this attempt's dispatch counts as done.
    observe(message) {
      if (!message || message.reply_to === null || message.reply_to === undefined) return null;
      for (const plan of registry.values()) {
        if (plan.status !== "running") continue;
        const step = currentStep(plan);
        if (!step || step.status !== "running") continue;
        if (step.dispatch_message_id !== message.reply_to) continue;
        if (message.from !== step.assignee) continue;
        const fileIds = [];
        if (message.type === "file") {
          try {
            const ref = JSON.parse(message.body);
            if (ref && typeof ref.id === "string") fileIds.push(ref.id);
          } catch {
            /* ignore malformed file bodies */
          }
        }
        registry.append({
          op: "step_done",
          plan_id: plan.plan_id,
          step: step.n,
          reply_message_id: message.id,
          file_ids: fileIds,
        });
        return { plan: registry.get(plan.plan_id), step: step.n, done: true };
      }
      return null;
    },

    retry(id, step) {
      const plan = registry.get(id);
      if (!plan) throw Object.assign(new Error("plan not found"), { code: "NOT_FOUND" });
      const s = stepOf(plan, step);
      if (!s || s.status !== "failed") throw Object.assign(new Error("step is not failed"), { code: "CONFLICT" });
      registry.append({ op: "step_retry", plan_id: id, step, attempt: s.attempt + 1 });
      return registry.get(id);
    },

    stop(id) {
      const plan = registry.get(id);
      if (!plan) throw Object.assign(new Error("plan not found"), { code: "NOT_FOUND" });
      if (plan.status === "done" || plan.status === "stopped") return plan;
      registry.append({ op: "stop", plan_id: id });
      return registry.get(id);
    },

    // Change the assignee of a step that has not started yet.
    assign(id, step, assignee) {
      const plan = registry.get(id);
      if (!plan) throw Object.assign(new Error("plan not found"), { code: "NOT_FOUND" });
      if (!IDENTITY_RE.test(assignee ?? "")) throw Object.assign(new Error("invalid assignee"), { code: "BAD_INPUT" });
      const s = stepOf(plan, step);
      if (!s || s.status !== "pending") throw Object.assign(new Error("step is not pending"), { code: "CONFLICT" });
      registry.append({ op: "assign", plan_id: id, step, assignee });
      return registry.get(id);
    },

    // Manual completion is an explicit human override, not a forged receipt.
    // It records the real step number and leaves the timeline unchanged.
    complete(id, step) {
      const plan = registry.get(id);
      if (!plan) throw Object.assign(new Error("plan not found"), { code: "NOT_FOUND" });
      const s = stepOf(plan, step);
      if (!s) throw Object.assign(new Error("step not found"), { code: "NOT_FOUND" });
      registry.append({ op: "step_done", plan_id: id, step, reply_message_id: null, file_ids: [] });
      return registry.get(id);
    },

    fail(id, step, error) {
      const plan = registry.get(id);
      if (!plan) return null;
      const s = stepOf(plan, step);
      if (!s || s.status !== "running") return null;
      registry.append({ op: "step_failed", plan_id: id, step, error });
      return registry.get(id);
    },

    // Timeout sweep: only mark failed, never auto-redispatch.
    sweep() {
      const cutoff = Date.now();
      const expired = [];
      for (const plan of registry.values()) {
        if (plan.status !== "running") continue;
        const step = currentStep(plan);
        if (!step || step.status !== "running" || !step.deadline_ts) continue;
        if (new Date(step.deadline_ts).getTime() > cutoff) continue;
        registry.append({ op: "step_failed", plan_id: plan.plan_id, step: step.n, error: "timeout" });
        expired.push({ plan_id: plan.plan_id, step: step.n });
      }
      return expired;
    },

    // Reconciliation on Hub restart: stale dispatching states and missed replies.
    reconcile(store) {
      const stale = [];
      for (const plan of registry.values()) {
        const step = currentStep(plan);
        if (!step || step.status !== "running") continue;
        if (!step.dispatch_message_id) {
          const age = Date.now() - new Date(plan.updated_at).getTime();
          if (age > DISPATCHING_STALE_MS) {
            registry.append({ op: "step_failed", plan_id: plan.plan_id, step: step.n, error: "dispatch_lost" });
            stale.push(plan.plan_id);
          }
        }
      }
      if (store?.since) {
        const window = store.since(0, { limit: 1000 });
        for (const message of window.messages) {
          this.observe(message);
        }
      }
      return stale;
    },

    summary(plan) {
      const done = plan.steps.filter((s) => s.status === "done").length;
      return {
        plan_id: plan.plan_id,
        group: plan.group,
        title: plan.title,
        status: plan.status,
        auto_handoff: plan.auto_handoff,
        card_message_id: plan.card_message_id,
        steps_done: done,
        steps_total: plan.steps.length,
        current_step: currentStep(plan)?.n ?? null,
        created_by: plan.created_by,
        created_at: plan.created_at,
      };
    },

    close() { registry.close(); },
  };
}

export { MAX_STEPS, STEP_TIMEOUT_MS };
