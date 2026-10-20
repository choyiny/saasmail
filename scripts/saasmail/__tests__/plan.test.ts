import { describe, expect, it } from "vitest";
import type { CatchAll, Queue } from "../cloudflare.ts";
import { resourceNames } from "../names.ts";
import { observe, type MailInputs, type Observed } from "../observe.ts";
import {
  catchAllOwner,
  computePlan,
  formatPlan,
  planDigest,
  PlanStop,
  type Desired,
  type Plan,
} from "../plan.ts";
import {
  newState,
  recordStep,
  type InstallState,
  type Resource,
} from "../state.ts";
import { fakeCloudflare } from "./fakes.ts";

const names = resourceNames("saasmail");
const installationId = "saasmail-1a2b3c4d5e6f";
const ownershipNonce = "n".repeat(64);
const desired: Desired = {
  installationId,
  ownershipNonce,
  names,
  inboundDomains: [],
  provider: "cloudflare",
  sendDomains: [],
};

const MARKER_KEY = ".saasmail/ownership.json";

function empty(): Observed {
  return {
    worker: { exists: false, vars: null },
    d1: [],
    d1Tables: {},
    d1InstallRow: {},
    r2: [],
    r2Markers: {},
    r2Empty: {},
    queues: [],
    workflows: [],
    zones: {},
    routing: {},
    sending: {},
  };
}

function state(): InstallState {
  return {
    ...newState({
      installationId,
      accountId: "acc",
      inputs: {
        name: "saasmail",
        hostname: "mail.example.com",
        workersDev: false,
        inboundDomains: ["example.com"],
        provider: "cloudflare",
        sendDomains: ["example.com"],
        cookiePrefix: "saasmail",
      },
      names,
      baseUrl: "https://mail.example.com",
    }),
    ownershipNonce,
  };
}

function marker(key: string, nonce = ownershipNonce): string {
  return JSON.stringify({ installationId, ownershipNonce: nonce, key });
}

function rec(
  key: string,
  kind: Resource["kind"],
  name: string,
  id: string,
): Resource {
  return { key, kind, name, id, ownership: "created", state: "ready" };
}

function tuples(plan: Plan) {
  return plan.actions.map((a) => [a.action, a.kind, a.name]);
}

function stopMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PlanStop);
    return (e as Error).message;
  }
  throw new Error("expected a PlanStop");
}

const notOurs = (n: string) =>
  `\`${n}\` already exists and was not created by this installation. Nothing was changed.`;

function queue(
  consumers: Queue["consumers"],
  producers: Queue["producers"] = [],
  id = "q-1",
): Queue {
  return { id, name: "saasmail-sequence-emails", producers, consumers };
}

const action = (plan: Plan, key: string) =>
  plan.actions.find((a) => a.key === key)?.action;

describe("computePlan", () => {
  it("fresh account: everything is created, in the fixed order", () => {
    const plan = computePlan(desired, empty(), null);
    expect(plan.installationId).toBe(installationId);
    expect(tuples(plan)).toEqual([
      ["create", "d1", "saasmail-db"],
      ["create", "r2", "saasmail-attachments"],
      ["create", "queue", "saasmail-sequence-emails"],
      ["create", "workflow", "saasmail-gmail-backfill"],
      ["create", "worker", "saasmail"],
    ]);
    expect(plan.actions.map((a) => a.key)).toEqual([
      "d1",
      "attachments",
      "queue",
      "workflow",
      "worker",
    ]);
    expect(plan.digest).toMatch(/^[0-9a-f]{12}$/);
  });

  it("same inputs give the same digest", () => {
    const a = computePlan(desired, empty(), null);
    const b = computePlan(desired, empty(), null);
    expect(a.digest).toBe(b.digest);
    expect(planDigest(installationId, a.actions)).toBe(a.digest);
  });

  it("the digest is the first 12 hex of sha256 over id and [action, kind, name]", async () => {
    const { createHash } = await import("node:crypto");
    const a = computePlan(desired, empty(), null);
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          installationId,
          a.actions.map((x) => [x.action, x.kind, x.name]),
        ]),
      )
      .digest("hex")
      .slice(0, 12);
    expect(a.digest).toBe(expected);
  });

  it("a changed action changes the digest", () => {
    const a = computePlan(desired, empty(), null);
    const changed = a.actions.map((x, i) =>
      i === 0 ? { ...x, action: "reuse" as const } : x,
    );
    expect(planDigest(installationId, changed)).not.toBe(a.digest);
    expect(planDigest("other-1a2b3c4d5e6f", a.actions)).not.toBe(a.digest);
  });

  it("stops on a bucket that exists without our marker", () => {
    const o = {
      ...empty(),
      r2: ["saasmail-attachments"],
      r2Markers: { "saasmail-attachments": null },
    };
    expect(stopMessage(() => computePlan(desired, o, null))).toBe(
      notOurs("saasmail-attachments"),
    );
  });

  it("reuses an empty unmarked bucket after a provision intent (apply writes the marker)", () => {
    const o = {
      ...empty(),
      r2: ["saasmail-attachments"],
      r2Markers: { "saasmail-attachments": null },
      r2Empty: { "saasmail-attachments": true },
    };
    const s = recordStep(state(), "provision-intent:attachments");
    expect(action(computePlan(desired, o, s), "attachments")).toBe("reuse");
  });

  it("stops on an empty unmarked bucket without a provision intent", () => {
    const o = {
      ...empty(),
      r2: ["saasmail-attachments"],
      r2Markers: { "saasmail-attachments": null },
      r2Empty: { "saasmail-attachments": true },
    };
    expect(stopMessage(() => computePlan(desired, o, state()))).toBe(
      notOurs("saasmail-attachments"),
    );
  });

  it("stops on a non-empty unmarked bucket after a provision intent, with a hint", () => {
    const o = {
      ...empty(),
      r2: ["saasmail-attachments"],
      r2Markers: { "saasmail-attachments": null },
      r2Empty: { "saasmail-attachments": false },
    };
    const s = recordStep(state(), "provision-intent:attachments");
    expect(stopMessage(() => computePlan(desired, o, s))).toBe(
      `${notOurs("saasmail-attachments")} It may be the bucket this install created before it was interrupted; if it is empty, delete it and run --resume.`,
    );
  });

  it("reuses a bucket whose marker matches", () => {
    const o = {
      ...empty(),
      r2: ["saasmail-attachments"],
      r2Markers: { "saasmail-attachments": marker("attachments") },
    };
    const plan = computePlan(desired, o, null);
    expect(plan.actions[1]).toEqual({
      action: "reuse",
      kind: "r2",
      key: "attachments",
      name: "saasmail-attachments",
    });
  });

  it("compares marker values, not raw text", () => {
    const reordered = JSON.stringify({
      key: "attachments",
      ownershipNonce,
      installationId,
    });
    const o = {
      ...empty(),
      r2: ["saasmail-attachments"],
      r2Markers: { "saasmail-attachments": ` ${reordered}\n` },
    };
    expect(computePlan(desired, o, null).actions[1].action).toBe("reuse");
  });

  it("stops on a bucket whose marker has another nonce, key, or is not JSON", () => {
    for (const body of [
      marker("attachments", "x".repeat(64)),
      marker("d1"),
      "not json",
      "null",
    ]) {
      const o = {
        ...empty(),
        r2: ["saasmail-attachments"],
        r2Markers: { "saasmail-attachments": body },
      };
      expect(stopMessage(() => computePlan(desired, o, null))).toBe(
        notOurs("saasmail-attachments"),
      );
    }
  });

  it("stops on a recorded bucket without our marker (the marker proves ownership)", () => {
    const s = state();
    s.resources.push(
      rec("attachments", "r2", "saasmail-attachments", "saasmail-attachments"),
    );
    const o = {
      ...empty(),
      r2: ["saasmail-attachments"],
      r2Markers: { "saasmail-attachments": null },
    };
    expect(stopMessage(() => computePlan(desired, o, s))).toBe(
      notOurs("saasmail-attachments"),
    );
  });

  it("reuses a recorded bucket whose marker matches", () => {
    const s = state();
    s.resources.push(
      rec("attachments", "r2", "saasmail-attachments", "saasmail-attachments"),
    );
    const o = {
      ...empty(),
      r2: ["saasmail-attachments"],
      r2Markers: { "saasmail-attachments": marker("attachments") },
    };
    expect(computePlan(desired, o, s).actions[1].action).toBe("reuse");
  });

  it("stops when a recorded worker, workflow or queue is missing", () => {
    for (const r of [
      rec("worker", "worker", "saasmail", "saasmail"),
      rec(
        "workflow",
        "workflow",
        "saasmail-gmail-backfill",
        "saasmail-gmail-backfill",
      ),
      rec("queue", "queue", "saasmail-sequence-emails", "q-1"),
    ]) {
      const s = state();
      s.resources.push(r);
      const msg = stopMessage(() => computePlan(desired, empty(), s));
      expect(msg).toContain("recorded but missing");
      expect(msg).toContain(r.name);
    }
  });

  it("stops when two Workflows have our name", () => {
    const o = {
      ...empty(),
      workflows: [
        { name: "saasmail-gmail-backfill", scriptName: "saasmail" },
        { name: "saasmail-gmail-backfill", scriptName: "saasmail" },
      ],
    };
    const msg = stopMessage(() => computePlan(desired, o, null));
    expect(msg).toContain("saasmail-gmail-backfill");
    expect(msg).toContain("Nothing was changed.");
  });

  it("throws (not a PlanStop) when the state belongs to another installation", () => {
    for (const s of [
      { ...state(), installationId: "other-1a2b3c4d5e6f" },
      { ...state(), ownershipNonce: "x".repeat(64) },
    ]) {
      let err: unknown;
      try {
        computePlan(desired, empty(), s);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PlanStop);
    }
  });

  it("stops on a workflow bound to another script", () => {
    const o = {
      ...empty(),
      workflows: [
        { name: "saasmail-gmail-backfill", scriptName: "someone-else" },
      ],
    };
    expect(stopMessage(() => computePlan(desired, o, null))).toBe(
      notOurs("saasmail-gmail-backfill"),
    );
  });

  it("reuses a workflow bound to our worker", () => {
    const o = {
      ...empty(),
      workflows: [
        { name: "saasmail-gmail-backfill", scriptName: "saasmail" },
        { name: "unrelated", scriptName: "other" },
      ],
    };
    const plan = computePlan(desired, o, null);
    expect(plan.actions[3]).toEqual({
      action: "reuse",
      kind: "workflow",
      key: "workflow",
      name: "saasmail-gmail-backfill",
    });
  });

  it("stops when a recorded bucket is missing", () => {
    const s = state();
    s.resources.push(
      rec("attachments", "r2", "saasmail-attachments", "saasmail-attachments"),
    );
    const msg = stopMessage(() => computePlan(desired, empty(), s));
    expect(msg).toContain("recorded but missing");
    expect(msg).toContain("saasmail-attachments");
  });

  it("stops when a recorded D1 database was replaced by another with the same name", () => {
    const s = state();
    s.resources.push(rec("d1", "d1", "saasmail-db", "uuid-old"));
    const o = {
      ...empty(),
      d1: [{ uuid: "uuid-new", name: "saasmail-db" }],
      d1Tables: { "uuid-new": [] },
      d1InstallRow: { "uuid-new": null },
    };
    expect(stopMessage(() => computePlan(desired, o, s))).toContain(
      "recorded but missing",
    );
  });

  it("reuses a D1 database recorded with the same uuid", () => {
    const s = state();
    s.resources.push(rec("d1", "d1", "saasmail-db", "uuid-1"));
    const o = {
      ...empty(),
      d1: [{ uuid: "uuid-1", name: "saasmail-db" }],
      d1Tables: { "uuid-1": ["user"] },
      d1InstallRow: { "uuid-1": null },
    };
    expect(computePlan(desired, o, s).actions[0].action).toBe("reuse");
  });

  it("stops when two D1 databases have our name", () => {
    const o = {
      ...empty(),
      d1: [
        { uuid: "uuid-1", name: "saasmail-db" },
        { uuid: "uuid-2", name: "saasmail-db" },
      ],
      d1Tables: { "uuid-1": [], "uuid-2": [] },
      d1InstallRow: { "uuid-1": null, "uuid-2": null },
    };
    const s = recordStep(state(), "provision-intent:d1");
    const msg = stopMessage(() => computePlan(desired, o, s));
    expect(msg).toContain("saasmail-db");
    expect(msg).toContain("Nothing was changed.");
  });

  it("accepts a same-name empty D1 database after a provision intent", () => {
    const o = {
      ...empty(),
      d1: [{ uuid: "uuid-1", name: "saasmail-db" }],
      d1Tables: { "uuid-1": [] },
      d1InstallRow: { "uuid-1": null },
    };
    const s = recordStep(state(), "provision-intent:d1");
    expect(computePlan(desired, o, s).actions[0]).toEqual({
      action: "reuse",
      kind: "d1",
      key: "d1",
      name: "saasmail-db",
    });
  });

  it("stops on a same-name empty D1 database without a provision intent", () => {
    const o = {
      ...empty(),
      d1: [{ uuid: "uuid-1", name: "saasmail-db" }],
      d1Tables: { "uuid-1": [] },
      d1InstallRow: { "uuid-1": null },
    };
    expect(stopMessage(() => computePlan(desired, o, state()))).toBe(
      notOurs("saasmail-db"),
    );
    expect(stopMessage(() => computePlan(desired, o, null))).toBe(
      notOurs("saasmail-db"),
    );
  });

  it("stops on a same-name D1 with tables and no matching install_state row", () => {
    const s = recordStep(state(), "provision-intent:d1");
    for (const row of [
      null,
      { installation_id: installationId, ownership_nonce: "x".repeat(64) },
      {
        installation_id: "other-1a2b3c4d5e6f",
        ownership_nonce: ownershipNonce,
      },
    ]) {
      const o = {
        ...empty(),
        d1: [{ uuid: "uuid-1", name: "saasmail-db" }],
        d1Tables: { "uuid-1": ["user", "install_state"] },
        d1InstallRow: { "uuid-1": row },
      };
      expect(stopMessage(() => computePlan(desired, o, s))).toBe(
        notOurs("saasmail-db"),
      );
    }
  });

  it("reuses a same-name D1 whose install_state row matches", () => {
    const o = {
      ...empty(),
      d1: [{ uuid: "uuid-1", name: "saasmail-db" }],
      d1Tables: { "uuid-1": ["user", "install_state"] },
      d1InstallRow: {
        "uuid-1": {
          installation_id: installationId,
          ownership_nonce: ownershipNonce,
        },
      },
    };
    expect(computePlan(desired, o, null).actions[0].action).toBe("reuse");
  });

  it("existing worker with our marker → deploy", () => {
    const o = {
      ...empty(),
      worker: {
        exists: true,
        vars: {
          SAASMAIL_INSTALLATION: JSON.stringify({
            ownershipNonce,
            installationId,
          }),
        },
      },
    };
    expect(computePlan(desired, o, null).actions[4]).toEqual({
      action: "deploy",
      kind: "worker",
      key: "worker",
      name: "saasmail",
    });
  });

  it("existing worker without our marker → stop", () => {
    for (const vars of [
      {} as Record<string, string>,
      { SAASMAIL_INSTALLATION: "" },
      { SAASMAIL_INSTALLATION: "not json" },
      {
        SAASMAIL_INSTALLATION: JSON.stringify({
          installationId,
          ownershipNonce: "x".repeat(64),
        }),
      },
    ]) {
      const o = { ...empty(), worker: { exists: true, vars } };
      expect(stopMessage(() => computePlan(desired, o, null))).toBe(
        notOurs("saasmail"),
      );
    }
  });
});

describe("computePlan: adopted resources", () => {
  const adopted = (
    key: string,
    kind: Resource["kind"],
    name: string,
    id: string,
  ): Resource => ({ ...rec(key, kind, name, id), ownership: "adopted" });
  const withRes = (...r: Resource[]) => {
    const s = state();
    s.resources.push(...r);
    return s;
  };

  it("adopted d1 without install row is reused", () => {
    const s = withRes(adopted("d1", "d1", "saasmail-db", "uuid-1"));
    const o = {
      ...empty(),
      d1: [{ uuid: "uuid-1", name: "saasmail-db" }],
      d1Tables: { "uuid-1": ["emails"] },
      d1InstallRow: { "uuid-1": null },
    };
    expect(computePlan(desired, o, s).actions[0].action).toBe("reuse");
  });

  it("adopted r2 with objects and no marker is reused", () => {
    const s = withRes(adopted("attachments", "r2", names.attachments, "x"));
    const o = {
      ...empty(),
      r2: [names.attachments],
      r2Empty: { [names.attachments]: false },
    };
    expect(computePlan(desired, o, s).actions[1].action).toBe("reuse");
  });

  it("adopted queue without our consumer and adopted workflow are reused", () => {
    const s = withRes(
      adopted("queue", "queue", names.queue, "q-1"),
      adopted("workflow", "workflow", names.workflow, names.workflow),
    );
    const o = {
      ...empty(),
      queues: [queue([], [], "q-1")],
      workflows: [{ name: names.workflow, scriptName: "other" }],
    };
    const a = computePlan(desired, o, s).actions;
    expect(a[2].action).toBe("reuse");
    expect(a[3].action).toBe("reuse");
  });

  it("adopted worker without SAASMAIL_INSTALLATION deploys", () => {
    const s = withRes(adopted("worker", "worker", "saasmail", "saasmail"));
    const o = { ...empty(), worker: { exists: true, vars: {} } };
    expect(computePlan(desired, o, s).actions[4].action).toBe("deploy");
  });

  it("adopted id mismatch stops", () => {
    const s = withRes(adopted("d1", "d1", "saasmail-db", "uuid-old"));
    const o = {
      ...empty(),
      d1: [{ uuid: "uuid-new", name: "saasmail-db" }],
    };
    expect(stopMessage(() => computePlan(desired, o, s))).toContain(
      "`saasmail-db` is recorded as adopted",
    );
    const s2 = withRes(adopted("queue", "queue", names.queue, "q-old"));
    const o2 = { ...empty(), queues: [queue([], [], "q-new")] };
    expect(stopMessage(() => computePlan(desired, o2, s2))).toContain(
      "recorded as adopted",
    );
  });
});

describe("computePlan: queue", () => {
  it("reuses a queue whose consumer is our worker", () => {
    const o = {
      ...empty(),
      queues: [
        queue(
          [{ type: "worker", script: "saasmail" }],
          [{ type: "worker", script: "saasmail" }],
        ),
      ],
    };
    expect(computePlan(desired, o, null).actions[2]).toEqual({
      action: "reuse",
      kind: "queue",
      key: "queue",
      name: "saasmail-sequence-emails",
    });
  });

  it("stops on a queue bound to another worker", () => {
    for (const q of [
      queue([{ type: "worker", script: "someone-else" }]),
      queue([], [{ type: "worker", script: "someone-else" }]),
      queue([]),
    ]) {
      const o = { ...empty(), queues: [q] };
      expect(stopMessage(() => computePlan(desired, o, null))).toBe(
        notOurs("saasmail-sequence-emails"),
      );
    }
  });

  it("reuses an unbound queue after a provision intent", () => {
    const o = { ...empty(), queues: [queue([])] };
    const s = recordStep(state(), "provision-intent:queue");
    expect(action(computePlan(desired, o, s), "queue")).toBe("reuse");
  });

  it("stops on a bound foreign queue even after a provision intent", () => {
    const s = recordStep(state(), "provision-intent:queue");
    for (const q of [
      queue([{ type: "worker", script: "someone-else" }]),
      queue([], [{ type: "worker", script: "someone-else" }]),
    ]) {
      const o = { ...empty(), queues: [q] };
      expect(stopMessage(() => computePlan(desired, o, s))).toBe(
        notOurs("saasmail-sequence-emails"),
      );
    }
  });

  it("stops when the recorded queue was replaced by another with the same name", () => {
    const s = state();
    s.resources.push(
      rec("queue", "queue", "saasmail-sequence-emails", "q-old"),
    );
    const o = {
      ...empty(),
      queues: [queue([{ type: "worker", script: "saasmail" }], [], "q-new")],
    };
    expect(stopMessage(() => computePlan(desired, o, s))).toContain(
      "recorded but missing",
    );
  });

  it("reuses a recorded queue with the same id", () => {
    const s = state();
    s.resources.push(rec("queue", "queue", "saasmail-sequence-emails", "q-1"));
    const o = {
      ...empty(),
      queues: [queue([{ type: "worker", script: "saasmail" }])],
    };
    expect(action(computePlan(desired, o, s), "queue")).toBe("reuse");
  });
});

describe("computePlan: Email Routing", () => {
  const inbound: Desired = {
    ...desired,
    inboundDomains: ["example.com", "example.org"],
  };

  function routed(
    catchAll: CatchAll | null,
    settings = { enabled: true, status: "ready" as string | null },
  ): Observed {
    return {
      ...empty(),
      zones: { "example.com": "zone-com", "example.org": "zone-org" },
      routing: {
        "example.com": { ...settings, catchAll },
        "example.org": { enabled: false, status: null, catchAll: null },
      },
    };
  }

  it("adds one routing action per inbound domain after the worker, in the order given", () => {
    const plan = computePlan(inbound, routed(null), null);
    expect(tuples(plan).slice(5)).toEqual([
      ["create", "routing", "example.com"],
      ["create", "routing", "example.org"],
    ]);
    expect(plan.actions.slice(5).map((a) => a.key)).toEqual([
      "routing:example.com",
      "routing:example.org",
    ]);
  });

  it("takes over the dashboard default catch-all (drop, or disabled)", () => {
    for (const c of [
      { enabled: true, actions: [{ type: "drop" }] },
      { enabled: false, actions: [{ type: "drop" }] },
      {
        enabled: false,
        actions: [{ type: "forward", value: ["someone@else.com"] }],
      },
    ]) {
      expect(
        action(computePlan(inbound, routed(c), null), "routing:example.com"),
      ).toBe("create");
    }
  });

  it("reuses a catch-all that already sends to our worker", () => {
    const o = routed({
      enabled: true,
      actions: [{ type: "worker", value: ["saasmail"] }],
    });
    expect(action(computePlan(inbound, o, null), "routing:example.com")).toBe(
      "reuse",
    );
  });

  it("re-creates our catch-all while Email Routing itself is off", () => {
    const o = routed(
      { enabled: true, actions: [{ type: "worker", value: ["saasmail"] }] },
      { enabled: false, status: "unconfigured" },
    );
    expect(action(computePlan(inbound, o, null), "routing:example.com")).toBe(
      "create",
    );
  });

  it("stops on a catch-all that forwards mail elsewhere", () => {
    const o = routed({
      enabled: true,
      actions: [{ type: "forward", value: ["someone@else.com"] }],
    });
    expect(stopMessage(() => computePlan(inbound, o, null))).toBe(
      "`example.com`'s catch-all rule already sends mail elsewhere and was not set by this installation. Nothing was changed.",
    );
  });

  it("stops on a catch-all that sends to another worker", () => {
    const o = routed({
      enabled: true,
      actions: [{ type: "worker", value: ["someone-else"] }],
    });
    expect(stopMessage(() => computePlan(inbound, o, null))).toBe(
      "`example.com`'s catch-all rule already sends mail elsewhere and was not set by this installation. Nothing was changed.",
    );
  });

  it("stops when an inbound domain's zone is not in the account", () => {
    const o = { ...routed(null), zones: { "example.com": "zone-com" } };
    expect(stopMessage(() => computePlan(inbound, o, null))).toBe(
      "Zone for `example.org` not found in this account. Nothing was changed.",
    );
  });
});

describe("computePlan: Email Sending", () => {
  const sending: Desired = {
    ...desired,
    inboundDomains: ["example.com"],
    sendDomains: ["example.com", "mail.example.org"],
  };

  function observed(present: string[]): Observed {
    const has = new Set(present);
    return {
      ...empty(),
      zones: { "example.com": "zone-com", "mail.example.org": "zone-org" },
      routing: {
        "example.com": { enabled: false, status: null, catchAll: null },
      },
      sending: {
        "example.com": { present: has.has("example.com") },
        "mail.example.org": {
          present: has.has("mail.example.org"),
        },
      },
    };
  }

  it("adds one sending action per send domain after routing", () => {
    const plan = computePlan(sending, observed(["example.com"]), null);
    expect(tuples(plan).slice(5)).toEqual([
      ["create", "routing", "example.com"],
      ["reuse", "sending", "example.com"],
      ["create", "sending", "mail.example.org"],
    ]);
    expect(plan.actions.at(-1)?.key).toBe("sending:mail.example.org");
  });

  it("plans no sending for another provider", () => {
    const plan = computePlan(
      { ...sending, provider: "resend" },
      observed([]),
      null,
    );
    expect(plan.actions.map((a) => a.kind)).not.toContain("sending");
  });

  it("stops when a send domain's zone is not in the account", () => {
    const o = { ...observed([]), zones: { "example.com": "zone-com" } };
    expect(stopMessage(() => computePlan(sending, o, null))).toBe(
      "Zone for `mail.example.org` not found in this account. Nothing was changed.",
    );
  });

  it("domains change the digest", () => {
    const a = computePlan(sending, observed([]), null);
    const b = computePlan(
      { ...sending, sendDomains: ["example.com"] },
      observed([]),
      null,
    );
    expect(a.digest).not.toBe(b.digest);
  });
});

describe("formatPlan", () => {
  it("ends with the no-change line and shows hostname, URL and mail", () => {
    const s = state();
    const plan = computePlan(
      {
        ...desired,
        inboundDomains: ["example.com"],
        sendDomains: ["example.com"],
      },
      {
        ...empty(),
        zones: { "example.com": "zone-com" },
        routing: {
          "example.com": { enabled: false, status: null, catchAll: null },
        },
        sending: { "example.com": { present: false } },
      },
      null,
    );
    const out = formatPlan(plan, s.inputs, s.baseUrl);
    const lines = out.split("\n");
    expect(lines.at(-1)).toBe(
      "No Cloudflare resource or local file was changed.",
    );
    expect(lines).toContain("create  d1        saasmail-db");
    expect(lines).toContain("create  worker    saasmail");
    expect(lines).toContain("create  routing   example.com");
    expect(lines).toContain("create  sending   example.com");
    expect(out).toContain("mail.example.com");
    expect(out).toContain("https://mail.example.com");
    expect(lines).toContain("Inbound   example.com");
    expect(lines).toContain("Provider  cloudflare");
    expect(lines).toContain("Send      example.com");
  });

  it("formats a workers.dev install without mail domains", () => {
    const plan = computePlan(desired, empty(), null);
    const out = formatPlan(
      plan,
      {
        name: "saasmail",
        hostname: null,
        workersDev: true,
        inboundDomains: [],
        provider: "none",
        sendDomains: [],
        cookiePrefix: "saasmail",
      },
      "https://saasmail.acme.workers.dev",
    );
    const lines = out.split("\n");
    expect(lines).toContain("Hostname  workers.dev");
    expect(out).toContain("https://saasmail.acme.workers.dev");
    expect(lines).toContain("Inbound   (none)");
    expect(lines).toContain("Provider  none");
    expect(lines.some((l) => l.startsWith("Send "))).toBe(false);
    expect(lines.at(-1)).toBe(
      "No Cloudflare resource or local file was changed.",
    );
  });
});

describe("observe", () => {
  const mail: MailInputs = {
    inboundDomains: [],
    provider: "cloudflare",
    sendDomains: [],
  };

  it("reads only our resources and markers", async () => {
    const cf = fakeCloudflare({
      d1: [
        { uuid: "uuid-1", name: "saasmail-db" },
        { uuid: "uuid-2", name: "other-db" },
      ],
      r2: {
        "saasmail-attachments": {},
        "other-bucket": { [MARKER_KEY]: "x" },
      },
      workflows: [{ name: "saasmail-gmail-backfill", scriptName: "saasmail" }],
      workerVars: { saasmail: { SAASMAIL_INSTALLATION: "v" } },
      queues: [queue([{ type: "worker", script: "saasmail" }])],
    });
    const o = await observe(cf, "acc", names, mail);
    expect(o.worker).toEqual({
      exists: true,
      vars: { SAASMAIL_INSTALLATION: "v" },
    });
    expect(o.d1).toHaveLength(2);
    expect(o.d1Tables).toEqual({ "uuid-1": [] });
    expect(o.d1InstallRow).toEqual({ "uuid-1": null });
    expect(o.r2Markers).toEqual({ "saasmail-attachments": null });
    expect(o.r2Empty).toEqual({ "saasmail-attachments": true });
    expect(o.workflows).toEqual([
      { name: "saasmail-gmail-backfill", scriptName: "saasmail" },
    ]);
    expect(o.queues).toEqual([queue([{ type: "worker", script: "saasmail" }])]);
    const queried = cf.calls.filter((c) => c.method === "queryD1");
    expect(queried.map((c) => c.args[1])).toEqual(["uuid-1"]);
    // No install_state table, so no row query.
    expect(queried[0].args[2]).toBe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' " +
        "AND name NOT IN ('sqlite_sequence','d1_migrations')",
    );
    const markers = cf.calls.filter((c) => c.method === "getR2Object");
    expect(markers.map((c) => c.args.slice(1))).toEqual([
      ["saasmail-attachments", MARKER_KEY],
    ]);
    // No mail domains: no zone reads.
    expect(cf.calls.some((c) => c.method === "findZone")).toBe(false);
  });

  it("reads a marked bucket's marker and skips its emptiness", async () => {
    const cf = fakeCloudflare({
      r2: { "saasmail-attachments": { [MARKER_KEY]: marker("attachments") } },
    });
    const o = await observe(cf, "acc", names, mail);
    expect(o.r2Markers).toEqual({
      "saasmail-attachments": marker("attachments"),
    });
    expect(o.r2Empty).toEqual({});
  });

  it("reads the install_state row when that table exists", async () => {
    const cf = fakeCloudflare({
      d1: [{ uuid: "uuid-1", name: "saasmail-db" }],
    });
    const row = {
      installation_id: installationId,
      ownership_nonce: ownershipNonce,
    };
    cf.queryD1 = async (_a, _id, sql) =>
      sql.includes("sqlite_master")
        ? [{ name: "user" }, { name: "install_state" }]
        : [row];
    const o = await observe(cf, "acc", names, mail);
    expect(o.d1Tables).toEqual({ "uuid-1": ["user", "install_state"] });
    expect(o.d1InstallRow).toEqual({ "uuid-1": row });
  });

  it("reports a missing worker", async () => {
    const o = await observe(fakeCloudflare(), "acc", names, mail);
    expect(o.worker).toEqual({ exists: false, vars: null });
  });

  it("reads routing per inbound domain and sending per send domain by zone", async () => {
    const cf = fakeCloudflare({
      zones: [
        { id: "zone-com", name: "example.com", status: "active" },
        { id: "zone-org", name: "example.org", status: "active" },
      ],
      routing: { "zone-com": { enabled: true, status: "ready" } },
      catchAll: {
        "zone-com": {
          enabled: true,
          actions: [{ type: "worker", value: ["saasmail"] }],
        },
      },
      sending: {
        "zone-org": [{ id: "sub-1", name: "mail.example.org", enabled: true }],
      },
    });
    const o = await observe(cf, "acc", names, {
      inboundDomains: ["example.com", "missing.net"],
      provider: "cloudflare",
      sendDomains: ["mail.example.org", "example.com"],
    });
    expect(o.zones).toEqual({
      "example.com": "zone-com",
      "missing.net": null,
      "mail.example.org": "zone-org",
    });
    expect(o.routing).toEqual({
      "example.com": {
        enabled: true,
        status: "ready",
        catchAll: {
          enabled: true,
          actions: [{ type: "worker", value: ["saasmail"] }],
        },
      },
    });
    expect(o.sending).toEqual({
      "mail.example.org": { present: true },
      "example.com": { present: false },
    });
  });

  it("reads no sending subdomains for another provider", async () => {
    const cf = fakeCloudflare({
      zones: [{ id: "zone-com", name: "example.com", status: "active" }],
    });
    const o = await observe(cf, "acc", names, {
      inboundDomains: [],
      provider: "resend",
      sendDomains: ["example.com"],
    });
    expect(o.sending).toEqual({});
    expect(cf.calls.some((c) => c.method === "listSendingSubdomains")).toBe(
      false,
    );
  });
});

describe("catchAllOwner", () => {
  const rule = (actions: CatchAll["actions"], enabled = true): CatchAll =>
    ({ enabled, actions }) as CatchAll;

  it("a rule with several actions is taken, even if one is ours", () => {
    expect(
      catchAllOwner(
        rule([
          { type: "worker", value: ["acme-worker"] },
          { type: "forward", value: ["me@example.com"] },
        ]),
        "acme-worker",
      ),
    ).toBe("taken");
  });

  it("an enabled rule with no actions is taken", () => {
    expect(catchAllOwner(rule([]), "acme-worker")).toBe("taken");
  });
});
