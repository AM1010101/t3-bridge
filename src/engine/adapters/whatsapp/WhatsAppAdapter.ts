import { BUTTON_PREFIX, ButtonStore } from "../../core/ButtonStore.ts";
import {
  buttonInbound,
  LONG_REPLY,
  postText,
  RUN_EMOJI,
  safeFileName,
  STOP_EMOJI,
  type ChatButton,
} from "../../core/chatText.ts";
import { reportPreview, reportTitle, splitMarkdown, truncate } from "../../core/markdown.ts";
import {
  PlatformError,
  type AdapterHandlers,
  type ChatAdapter,
  type ConversationRef,
  type ImageRef,
  type InboundFile,
  type InboundMessage,
  type MessageRef,
  type OutboundPost,
  type RunStatus,
} from "../../core/types.ts";
import type { Logger } from "../../log.ts";
import { toWhatsApp, WHATSAPP_INTERACTIVE_BODY_LIMIT, WHATSAPP_MESSAGE_LIMIT } from "./format.ts";
import {
  addListener,
  publicWebhookUrl,
  removeListener,
  verifyTokenFor,
  type WhatsAppChangeValue,
} from "./webhook.ts";

const GRAPH = "https://graph.facebook.com/v23.0";
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** WhatsApp shows images up to 5 MB, as JPEG or PNG; anything else goes as a document. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** "typing…" lasts 25 seconds or until the next message; it is renewed while a run lasts. */
const TYPING_RENEW_MS = 20_000;
const TYPING_MAX_MS = 15 * 60_000;
const SEEN_LIMIT = 500;

export interface WhatsAppCredentials {
  readonly accessToken: string;
  readonly phoneNumberId: string;
  readonly appSecret: string;
}

interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string };
}

/** What WhatsApp's error codes mean for the person using the bot. */
function explain(error: GraphError): string {
  switch (error.code) {
    case 131047:
      return "WhatsApp only lets the bot message you within 24 hours of your last message. Send the bot any message to reopen the window.";
    case 131030:
      return "This number is not on the test number's allowed list. Add it in Meta under WhatsApp → API Setup → To.";
    case 190:
      return "The WhatsApp access token is not valid any more. Make a permanent System User token and replace it in T3 Bridge.";
    default:
      return error.error_data?.details ?? error.message ?? "request failed";
  }
}

async function graphRequest<T>(
  token: string,
  path: string,
  init: { method?: "GET" | "POST"; json?: unknown; form?: FormData } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${GRAPH}/${path}`, {
      method: init.method ?? (init.json === undefined && init.form === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      ...(init.form === undefined ? {} : { body: init.form }),
    });
    const json = (await response.json().catch(() => ({}))) as T & { error?: GraphError };
    if (response.ok && json.error === undefined) return json;
    const error = json.error ?? { message: response.statusText };
    const rateLimited = response.status === 429 || [4, 80007, 130429, 131056].includes(error.code ?? 0);
    if (rateLimited && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    const permanent =
      response.status === 401 ||
      response.status === 403 ||
      [100, 190, 131026, 131030, 131047, 131051].includes(error.code ?? 0);
    throw new PlatformError(`WhatsApp: ${explain(error)}`, response.status, permanent);
  }
}

/** Checks the credentials from Meta before they are saved, and says what to give Meta back. */
export async function testWhatsAppCredentials(input: Partial<WhatsAppCredentials>) {
  const accessToken = String(input?.accessToken ?? "").trim();
  const phoneNumberId = String(input?.phoneNumberId ?? "").trim();
  const appSecret = String(input?.appSecret ?? "").trim();
  if (!/^\d{6,20}$/.test(phoneNumberId))
    throw new Error("The phone number ID is a long number, under WhatsApp → API Setup (not the phone number itself).");
  if (!/^[a-f0-9]{32}$/i.test(appSecret))
    throw new Error("The app secret is 32 letters and digits, under App settings → Basic → App secret.");
  if (accessToken.length < 50 || /\s/.test(accessToken))
    throw new Error("That does not look like a WhatsApp access token (a long string starting with EAA).");
  const phone = await graphRequest<{ display_phone_number?: string; verified_name?: string }>(
    accessToken,
    `${phoneNumberId}?fields=display_phone_number,verified_name`,
  );
  const digits = (phone.display_phone_number ?? "").replace(/\D/g, "");
  return {
    botUser: phone.verified_name ?? phone.display_phone_number ?? phoneNumberId,
    phone: phone.display_phone_number ?? "",
    link: digits ? `https://wa.me/${digits}` : "",
    verifyToken: verifyTokenFor(appSecret, phoneNumberId),
    webhookUrl: publicWebhookUrl(),
  };
}

interface WhatsAppMedia {
  id: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
}

/** Only the parts of an inbound message the bridge reads. */
export interface WhatsAppMessage {
  id: string;
  from: string;
  type: string;
  text?: { body?: string };
  context?: { id?: string };
  image?: WhatsAppMedia;
  document?: WhatsAppMedia;
  audio?: WhatsAppMedia;
  video?: WhatsAppMedia;
  sticker?: WhatsAppMedia;
  interactive?: { button_reply?: { id: string }; list_reply?: { id: string } };
  button?: { text?: string; payload?: string };
  reaction?: { message_id?: string; emoji?: string };
}

/**
 * WhatsApp through Meta's Cloud API: messages arrive by webhook, replies go out through the
 * Graph API. WhatsApp cannot edit a sent message, so a streaming reply is sent once, when it is
 * complete, and posts that change often (subagents, todos) are sent when they start and when
 * they finish. Approvals and questions use reply buttons, or a list for more than three.
 */
export class WhatsAppAdapter implements ChatAdapter {
  private handlers: AdapterHandlers | null = null;
  private identity = "";
  private readonly seen = new Set<string>();
  private readonly typing = new Map<string, NodeJS.Timeout>();
  /** The open question per chat, so a plain message (not a quoted reply) answers it. */
  private readonly openQuestion = new Map<string, string>();

  private readonly credentials: WhatsAppCredentials;
  private readonly log: Logger;
  private readonly name: string;
  private readonly buttons: ButtonStore;

  constructor(credentials: WhatsAppCredentials, log: Logger, name: string, buttons: ButtonStore) {
    this.credentials = credentials;
    this.log = log;
    this.name = name;
    this.buttons = buttons;
  }

  private request<T>(path: string, init?: Parameters<typeof graphRequest>[2]) {
    return graphRequest<T>(this.credentials.accessToken, path, init);
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    this.handlers = handlers;
    handlers.onStatus({ state: "connecting" });
    const { phoneNumberId, appSecret } = this.credentials;
    try {
      const phone = await this.request<{ display_phone_number?: string; verified_name?: string }>(
        `${phoneNumberId}?fields=display_phone_number,verified_name`,
      );
      this.identity = `${phone.display_phone_number ?? phone.verified_name ?? phoneNumberId} on WhatsApp`;
      await addListener({
        phoneNumberId,
        appSecret,
        verifyToken: verifyTokenFor(appSecret, phoneNumberId),
        onValue: (value) =>
          void this.onValue(value).catch((error: unknown) => this.log.error(`[${this.name}] WhatsApp webhook`, error)),
      });
    } catch (error) {
      handlers.onStatus({ state: "error", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    handlers.onStatus({ state: "connected", identity: this.identity });
  }

  async stop(): Promise<void> {
    await removeListener(this.credentials.phoneNumberId);
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
  }

  // ── inbound ─────────────────────────────────────────────────────────────

  private async onValue(value: WhatsAppChangeValue) {
    for (const status of value.statuses ?? []) {
      if (status.status !== "failed") continue;
      const errors = (status.errors as GraphError[] | undefined) ?? [];
      this.log.warn(`[${this.name}] WhatsApp could not deliver a message: ${errors.map(explain).join("; ") || "unknown reason"}`);
    }
    const names = new Map((value.contacts ?? []).map((contact) => [contact.wa_id, contact.profile?.name ?? ""]));
    for (const raw of value.messages ?? []) {
      const message = raw as unknown as WhatsAppMessage;
      if (!message.id || !message.from || this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);
      await this.onMessage(message, names.get(message.from) || message.from);
    }
  }

  private async onMessage(message: WhatsAppMessage, userName: string) {
    const chat = message.from;
    if (message.type === "interactive") {
      const id = message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id ?? "";
      return this.onButton(chat, id, message.id);
    }
    if (message.type === "reaction") {
      if (STOP_EMOJI.has(message.reaction?.emoji ?? "")) await this.handlers?.onAction({ type: "stop", userId: chat });
      return;
    }
    const media = messageMedia(message);
    const files: InboundFile[] = [];
    for (const item of media) {
      files.push({
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: 0,
        download: () => this.download(item.id),
      });
    }
    let text = message.text?.body ?? message.button?.text ?? media.find((item) => item.caption)?.caption ?? "";
    if (!text && files.length === 0) text = `(a ${message.type} message, which T3 Bridge cannot read)`;
    const quoted = message.context?.id;
    const replyTo = quoted ?? (text ? this.openQuestion.get(chat) : undefined);
    await this.handlers?.onMessage({
      conversation: { id: chat, label: "Direct message" },
      ref: { channel: chat, ts: message.id },
      userId: chat,
      userName,
      isDirect: true,
      mentionsBot: true,
      text: text.trim(),
      files,
      replyTo: replyTo === undefined ? null : { channel: chat, ts: replyTo },
    });
  }

  private async download(mediaId: string): Promise<Buffer> {
    const info = await this.request<{ url?: string; file_size?: number }>(mediaId);
    if (!info.url) throw new Error("WhatsApp did not provide the file");
    if ((info.file_size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error("The file is larger than 25 MB");
    const response = await fetch(info.url, { headers: { authorization: `Bearer ${this.credentials.accessToken}` } });
    if (!response.ok) throw new Error(`WhatsApp file download failed with ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async onButton(chat: string, data: string, messageId: string) {
    const action = data.startsWith(BUTTON_PREFIX) ? await this.buttons.get(data.slice(BUTTON_PREFIX.length)) : null;
    if (action === null) {
      await this.sendText(chat, "This button no longer works. Send your answer as a message instead.", messageId).catch(() => {});
      return;
    }
    if (action.type === "answer") this.openQuestion.delete(chat);
    await this.handlers?.onAction(buttonInbound(action, chat));
  }

  // ── outbound ────────────────────────────────────────────────────────────

  async reply(message: InboundMessage, text: string): Promise<void> {
    await this.sendText(message.conversation.id, text, message.ref.ts);
  }

  /** On WhatsApp a chat is the person's phone number. */
  async openDirect(userId: string): Promise<ConversationRef> {
    return { id: userId, label: "Direct message" };
  }

  async setRunStatus(message: MessageRef, status: RunStatus): Promise<void> {
    if (!message.channel || !message.ts) return;
    await this.send(message.channel, { type: "reaction", reaction: { message_id: message.ts, emoji: RUN_EMOJI[status] } });
    this.setTyping(message, status === "running");
  }

  private setTyping(message: MessageRef, working: boolean) {
    const key = message.channel!;
    clearInterval(this.typing.get(key));
    this.typing.delete(key);
    if (!working) return;
    const type = () =>
      void this.request(`${this.credentials.phoneNumberId}/messages`, {
        json: {
          messaging_product: "whatsapp",
          status: "read",
          message_id: message.ts,
          typing_indicator: { type: "text" },
        },
      }).catch(() => {});
    type();
    const timer = setInterval(type, TYPING_RENEW_MS);
    timer.unref();
    this.typing.set(key, timer);
    setTimeout(() => {
      clearInterval(timer);
      if (this.typing.get(key) === timer) this.typing.delete(key);
    }, TYPING_MAX_MS).unref();
  }

  async upsert(conversation: ConversationRef, post: OutboundPost, existing: MessageRef | null): Promise<MessageRef> {
    const chat = existing?.channel ?? conversation.id;
    const stage = postStage(post);
    // Nothing to send now: still streaming, or the post has not reached a new stage.
    if (stage === null || stage === existing?.stage) return existing ?? { channel: chat };
    const ref: Record<string, string> = { ...existing, channel: chat, stage };
    if (post.kind === "question") {
      if (post.resolved) {
        if (this.openQuestion.get(chat) === existing?.ts) this.openQuestion.delete(chat);
        return ref;
      }
    }
    if (post.kind === "approval" && post.resolved !== null) return ref;
    if (post.kind === "html") {
      ref.ts = await this.postHtml(chat, post);
      return ref;
    }
    const text = postText(post);
    const long = post.kind === "assistant" && post.markdown.length > LONG_REPLY;
    const title = long ? reportTitle(post.markdown) : "";
    const body = long ? `${reportPreview(post.markdown)}\n\n📄 **Full reply attached:** ${title}` : text.markdown;
    ref.ts = await this.sendMarkdown(chat, body, text.buttons.flat());
    if (post.kind === "question") this.openQuestion.set(chat, ref.ts);
    // The main message is sent; a failed follow-up must not make the caller send it again.
    try {
      if (long) {
        await this.sendFile(chat, "document", {
          name: `${safeFileName(title)}.md`,
          bytes: Buffer.from(post.markdown),
          mimeType: "text/markdown",
        });
      }
      if (post.kind === "assistant" && post.images.length > 0) await this.uploadImages(chat, post.images);
    } catch (error) {
      this.log.warn(`[${this.name}] follow-up for ${post.kind} failed`, error);
    }
    return ref;
  }

  private async send(to: string, message: Record<string, unknown>, replyTo?: string): Promise<string> {
    const result = await this.request<{ messages?: Array<{ id: string }> }>(`${this.credentials.phoneNumberId}/messages`, {
      json: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        ...message,
        ...(replyTo === undefined ? {} : { context: { message_id: replyTo } }),
      },
    });
    return result.messages?.[0]?.id ?? "";
  }

  private sendText(to: string, markdown: string, replyTo?: string) {
    return this.send(to, { type: "text", text: { body: truncate(toWhatsApp(markdown), 4096), preview_url: false } }, replyTo);
  }

  /** Sends markdown in as many messages as it needs; buttons go on the last. Returns the id to reply to. */
  private async sendMarkdown(to: string, markdown: string, buttons: ReadonlyArray<ChatButton>): Promise<string> {
    const chunks = splitMarkdown(markdown.trim() || "…", WHATSAPP_MESSAGE_LIMIT);
    if (buttons.length === 0) {
      let first = "";
      for (const chunk of chunks) first ||= await this.sendText(to, chunk);
      return first;
    }
    const last = toWhatsApp(chunks.at(-1)!);
    const fits = last.length <= WHATSAPP_INTERACTIVE_BODY_LIMIT;
    for (const chunk of fits ? chunks.slice(0, -1) : chunks) await this.sendText(to, chunk);
    return this.sendButtons(to, fits ? last : "Choose an answer:", buttons);
  }

  private async sendButtons(to: string, body: string, buttons: ReadonlyArray<ChatButton>): Promise<string> {
    const ids = await Promise.all(buttons.slice(0, 10).map(async (button) => `${BUTTON_PREFIX}${await this.buttons.put(button.action)}`));
    const interactive =
      buttons.length <= 3
        ? {
            type: "button",
            body: { text: body },
            action: {
              buttons: buttons.map((button, index) => ({
                type: "reply",
                reply: { id: ids[index], title: truncate(button.label, 20) },
              })),
            },
          }
        : {
            type: "list",
            body: { text: body },
            action: {
              button: "Choose",
              sections: [
                {
                  title: "Answers",
                  rows: buttons.slice(0, 10).map((button, index) => ({
                    id: ids[index],
                    title: truncate(button.label, 24),
                    ...(button.label.length > 24 ? { description: truncate(button.label, 72) } : {}),
                  })),
                },
              ],
            },
          };
    return this.send(to, { type: "interactive", interactive });
  }

  private async uploadImages(to: string, images: ReadonlyArray<ImageRef>) {
    for (const image of images) {
      try {
        const loaded = await image.load();
        const file = { name: image.name, ...loaded };
        const photo = /^image\/(jpeg|png)$/.test(file.mimeType) && file.bytes.length <= MAX_IMAGE_BYTES;
        await this.sendFile(to, photo ? "image" : "document", file);
      } catch (error) {
        this.log.warn(`[${this.name}] uploading ${image.name} failed`, error);
      }
    }
  }

  private async sendFile(
    to: string,
    kind: "image" | "document",
    file: { name: string; bytes: Buffer; mimeType: string },
    caption?: string,
  ): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", file.mimeType);
    form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.name);
    const uploaded = await this.request<{ id: string }>(`${this.credentials.phoneNumberId}/media`, { form });
    return this.send(to, {
      type: kind,
      [kind]: {
        id: uploaded.id,
        ...(kind === "document" ? { filename: file.name } : {}),
        ...(caption ? { caption: toWhatsApp(caption) } : {}),
      },
    });
  }

  private async postHtml(to: string, post: Extract<OutboundPost, { kind: "html" }>): Promise<string> {
    try {
      const loaded = await post.html.load();
      return await this.sendFile(to, "document", { name: post.html.name, ...loaded }, `🖼 **${post.title}**`);
    } catch (error) {
      this.log.warn(`[${this.name}] sending ${post.html.name} failed`, error);
      return this.sendText(to, `🖼 ${post.title} (open it in T3)`);
    }
  }
}

/**
 * When a post is worth a new WhatsApp message, since sent messages cannot be edited: a key that
 * changes only at those moments, or null while there is nothing to send yet.
 */
export function postStage(post: OutboundPost): string | null {
  switch (post.kind) {
    case "assistant":
      return post.streaming ? null : "final";
    case "subagent":
      return ["completed", "failed", "cancelled"].includes(post.status) ? "done" : "started";
    case "subagents":
      return post.tasks.some((task) => ["pending", "running", "waiting"].includes(task.status)) ? "started" : "done";
    case "todo":
      return post.steps.every((step) => step.status === "completed") ? "done" : "started";
    case "approval":
      return post.resolved === null ? "open" : "resolved";
    case "question":
      return post.resolved ? "resolved" : "open";
    default:
      return "sent";
  }
}

function messageMedia(message: WhatsAppMessage) {
  const items: Array<{ id: string; name: string; mimeType: string; caption?: string }> = [];
  for (const kind of ["image", "document", "audio", "video", "sticker"] as const) {
    const media = message[kind];
    if (media?.id === undefined) continue;
    const mimeType = media.mime_type?.split(";")[0]?.trim() || "application/octet-stream";
    const extension = mimeType.split("/")[1]?.replace(/[^\w]/g, "") || "bin";
    items.push({
      id: media.id,
      name: media.filename ?? `${kind}-${message.id.slice(-8)}.${extension}`,
      mimeType,
      ...(media.caption ? { caption: media.caption } : {}),
    });
  }
  return items;
}
