import * as Crypto from "node:crypto";
import * as Http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { ButtonStore } from "../../core/ButtonStore.ts";
import type { InboundAction, InboundMessage, OutboundPost } from "../../core/types.ts";
import { makeLogger } from "../../log.ts";
import { toWhatsApp } from "./format.ts";
import { postStage, WhatsAppAdapter, type WhatsAppMessage } from "./WhatsAppAdapter.ts";
import { addListener, removeListener, validSignature, verifyTokenFor, webhookPort } from "./webhook.ts";

const SECRET = "0123456789abcdef0123456789abcdef";

function setup() {
  const sent: Array<Record<string, unknown>> = [];
  const inbound: InboundMessage[] = [];
  const actions: InboundAction[] = [];
  let id = 0;
  const adapter = new WhatsAppAdapter(
    { accessToken: "EAA".padEnd(60, "x"), phoneNumberId: "1234567", appSecret: SECRET },
    makeLogger(() => {}),
    "Test",
    new ButtonStore(null),
  );
  Object.assign(adapter as unknown as Record<string, unknown>, {
    request: async (path: string, init: { json?: Record<string, unknown> } = {}) => {
      if (init.json) sent.push(init.json);
      if (path.endsWith("/media")) return { id: "media-1" };
      return { messages: [{ id: `wamid.${++id}` }] };
    },
    handlers: {
      onMessage: async (message: InboundMessage) => void inbound.push(message),
      onAction: async (action: InboundAction) => void actions.push(action),
      onStatus: () => {},
    },
  });
  const receive = (message: Partial<WhatsAppMessage>) =>
    (adapter as unknown as { onValue: (value: unknown) => Promise<void> }).onValue({
      contacts: [{ wa_id: "447700900123", profile: { name: "Andy" } }],
      messages: [{ id: `in.${Math.random()}`, from: "447700900123", type: "text", ...message }],
    });
  return { adapter, sent, inbound, actions, receive };
}

const assistant = (markdown: string, streaming = false): OutboundPost => ({
  kind: "assistant",
  markdown,
  streaming,
  images: [],
});

describe("toWhatsApp", () => {
  it("converts markdown to WhatsApp formatting", () => {
    expect(toWhatsApp("# Title\n**bold** and *it* and ~~gone~~")).toBe("*Title*\n*bold* and _it_ and ~gone~");
    expect(toWhatsApp("see [docs](https://x.dev) or https://y.dev")).toBe("see docs (https://x.dev) or https://y.dev");
    expect(toWhatsApp("* one\n* two")).toBe("- one\n- two");
    expect(toWhatsApp("`**raw**`")).toBe("`**raw**`");
    expect(toWhatsApp("```ts\nconst a = **b**;\n```")).toBe("```\nconst a = **b**;\n```");
  });
});

describe("WhatsAppAdapter inbound", () => {
  it("reads a text message as a direct message", async () => {
    const { inbound, receive } = setup();
    await receive({ text: { body: "hello" } });
    expect(inbound[0]).toMatchObject({
      conversation: { id: "447700900123" },
      userId: "447700900123",
      userName: "Andy",
      isDirect: true,
      text: "hello",
      replyTo: null,
    });
  });

  it("ignores a message Meta delivers twice", async () => {
    const { inbound, adapter } = setup();
    const value = { messages: [{ id: "same", from: "1", type: "text", text: { body: "x" } }] };
    const onValue = (adapter as unknown as { onValue: (value: unknown) => Promise<void> }).onValue.bind(adapter);
    await onValue(value);
    await onValue(value);
    expect(inbound).toHaveLength(1);
  });

  it("turns a quoted reply into replyTo", async () => {
    const { inbound, receive } = setup();
    await receive({ text: { body: "yes" }, context: { id: "wamid.9" } });
    expect(inbound[0]!.replyTo).toEqual({ channel: "447700900123", ts: "wamid.9" });
  });

  it("stops the agent on a stop reaction", async () => {
    const { actions, receive } = setup();
    await receive({ type: "reaction", reaction: { message_id: "wamid.1", emoji: "🛑" } });
    expect(actions).toEqual([{ type: "stop", userId: "447700900123" }]);
  });
});

describe("WhatsAppAdapter outbound", () => {
  it("waits for a streaming reply to finish, then sends it once", async () => {
    const { adapter, sent } = setup();
    const conversation = { id: "447700900123", label: "Direct message" };
    let ref = await adapter.upsert(conversation, assistant("Hel", true), null);
    ref = await adapter.upsert(conversation, assistant("Hello", true), ref);
    expect(sent).toHaveLength(0);
    ref = await adapter.upsert(conversation, assistant("Hello **there**"), ref);
    ref = await adapter.upsert(conversation, assistant("Hello **there**"), ref);
    expect(sent).toEqual([
      expect.objectContaining({ to: "447700900123", type: "text", text: { body: "Hello *there*", preview_url: false } }),
    ]);
    expect(ref.ts).toBe("wamid.1");
  });

  it("sends approvals with reply buttons that come back as actions", async () => {
    const { adapter, sent, actions, receive } = setup();
    await adapter.upsert(
      { id: "447700900123", label: "Direct message" },
      {
        kind: "approval",
        threadId: "t1",
        requestId: "r1",
        source: "orchestrator",
        prompt: "Run tests?",
        decisions: ["accept", "decline"],
        resolved: null,
      },
      null,
    );
    const interactive = sent[0]!.interactive as { type: string; action: { buttons: Array<{ reply: { id: string; title: string } }> } };
    expect(interactive.type).toBe("button");
    expect(interactive.action.buttons.map((button) => button.reply.title)).toEqual(["Approve", "Decline"]);
    await receive({ type: "interactive", interactive: { button_reply: { id: interactive.action.buttons[0]!.reply.id } } });
    expect(actions[0]).toMatchObject({ type: "approval", requestId: "r1", decision: "accept" });
  });

  it("answers an open question with a plain message", async () => {
    const { adapter, inbound, receive } = setup();
    const ref = await adapter.upsert(
      { id: "447700900123", label: "Direct message" },
      {
        kind: "question",
        threadId: "t1",
        requestId: "r1",
        source: "orchestrator",
        questions: [{ id: "q", header: "Name", question: "What name?", options: [], multiSelect: false, allowCustomAnswer: true }],
        resolved: false,
      },
      null,
    );
    await receive({ text: { body: "Bob" } });
    expect(inbound[0]!.replyTo).toEqual({ channel: "447700900123", ts: ref.ts });
  });
});

describe("postStage", () => {
  it("sends subagent posts when they start and when they finish", () => {
    const task = { id: "a", title: "x", model: null, progress: null, result: null };
    expect(postStage({ kind: "subagent", ...task, status: "running" })).toBe("started");
    expect(postStage({ kind: "subagent", ...task, status: "completed" })).toBe("done");
  });
});

describe("webhook", () => {
  afterEach(() => removeListener("1234567"));

  it("checks Meta's signature", () => {
    const body = Buffer.from('{"a":1}');
    const signature = `sha256=${Crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;
    expect(validSignature(SECRET, body, signature)).toBe(true);
    expect(validSignature(SECRET, Buffer.from('{"a":2}'), signature)).toBe(false);
    expect(validSignature(SECRET, body, undefined)).toBe(false);
  });

  it("verifies the subscription and routes signed messages", async () => {
    process.env.T3_BRIDGE_WHATSAPP_PORT = String(48000 + Math.floor(Math.random() * 1000));
    const values: unknown[] = [];
    await addListener({
      phoneNumberId: "1234567",
      appSecret: SECRET,
      verifyToken: verifyTokenFor(SECRET, "1234567"),
      onValue: (value) => values.push(value),
    });
    const base = `http://127.0.0.1:${webhookPort()}/whatsapp/webhook`;
    const verify = await fetch(
      `${base}?hub.mode=subscribe&hub.verify_token=${verifyTokenFor(SECRET, "1234567")}&hub.challenge=42`,
    );
    expect([verify.status, await verify.text()]).toEqual([200, "42"]);
    expect((await fetch(`${base}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status).toBe(403);

    const body = JSON.stringify({
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "1234567" }, messages: [] } }] }],
    });
    const sign = (text: string) => `sha256=${Crypto.createHmac("sha256", SECRET).update(text).digest("hex")}`;
    const post = (signature: string) =>
      fetch(base, { method: "POST", body, headers: { "x-hub-signature-256": signature } });
    expect((await post("sha256=bad")).status).toBe(401);
    expect((await post(sign(body))).status).toBe(200);
    expect(values).toHaveLength(1);
    expect(Http.STATUS_CODES[200]).toBe("OK");
  });
});
