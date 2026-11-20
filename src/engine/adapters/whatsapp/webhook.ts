import * as Crypto from "node:crypto";
import * as Http from "node:http";

/**
 * WhatsApp delivers messages by webhook, so unlike the other platforms it needs a public HTTPS
 * URL. One local listener serves every WhatsApp bot; each bot registers under its phone number
 * id. It listens on 127.0.0.1 only: expose just this port publicly, e.g. with Tailscale Funnel,
 * never the control panel.
 */
export const WEBHOOK_PATH = "/whatsapp/webhook";
const MAX_BODY_BYTES = 1024 * 1024;

export function webhookPort(): number {
  return Number(process.env.T3_BRIDGE_WHATSAPP_PORT ?? 47822);
}

/** The public URL to give Meta, when the bridge was told its public address. */
export function publicWebhookUrl(): string | null {
  const base = process.env.T3_BRIDGE_WHATSAPP_PUBLIC_URL?.trim();
  return base ? `${base.replace(/\/+$/, "")}${WEBHOOK_PATH}` : null;
}

/** The verify token Meta sends when the webhook is set up; derived, so nothing extra is stored. */
export function verifyTokenFor(appSecret: string, phoneNumberId: string): string {
  return Crypto.createHmac("sha256", appSecret).update(`verify:${phoneNumberId}`).digest("base64url").slice(0, 24);
}

/** True when `signature` (the X-Hub-Signature-256 header) is Meta's signature of `body`. */
export function validSignature(appSecret: string, body: Buffer, signature: string | undefined): boolean {
  if (signature === undefined || !signature.startsWith("sha256=")) return false;
  const expected = Buffer.from(Crypto.createHmac("sha256", appSecret).update(body).digest("hex"));
  const provided = Buffer.from(signature.slice("sha256=".length));
  return provided.length === expected.length && Crypto.timingSafeEqual(provided, expected);
}

export interface WebhookListener {
  readonly phoneNumberId: string;
  readonly appSecret: string;
  readonly verifyToken: string;
  readonly onValue: (value: WhatsAppChangeValue) => void;
}

export interface WhatsAppChangeValue {
  readonly messaging_product?: string;
  readonly metadata?: { readonly display_phone_number?: string; readonly phone_number_id?: string };
  readonly contacts?: ReadonlyArray<{ readonly wa_id: string; readonly profile?: { readonly name?: string } }>;
  readonly messages?: ReadonlyArray<Record<string, unknown>>;
  readonly statuses?: ReadonlyArray<Record<string, unknown>>;
}

const listeners = new Map<string, WebhookListener>();
let server: Promise<Http.Server> | null = null;

export async function addListener(listener: WebhookListener): Promise<void> {
  listeners.set(listener.phoneNumberId, listener);
  server ??= open().catch((error: unknown) => {
    server = null;
    throw error;
  });
  try {
    await server;
  } catch (error) {
    listeners.delete(listener.phoneNumberId);
    throw error;
  }
}

export async function removeListener(phoneNumberId: string): Promise<void> {
  listeners.delete(phoneNumberId);
  if (listeners.size > 0 || server === null) return;
  const closing = server;
  server = null;
  const http = await closing.catch(() => null);
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
}

function open(): Promise<Http.Server> {
  const http = Http.createServer((request, response) => void handle(request, response));
  return new Promise((resolve, reject) => {
    http.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`WhatsApp webhook port ${webhookPort()} is in use. Set T3_BRIDGE_WHATSAPP_PORT to another port.`)
          : error,
      ),
    );
    http.listen(webhookPort(), "127.0.0.1", () => resolve(http));
  });
}

export async function handle(request: Http.IncomingMessage, response: Http.ServerResponse) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const end = (status: number, text = "") => {
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(text);
  };
  if (url.pathname !== WEBHOOK_PATH) return end(404);
  if (request.method === "GET") {
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const known = [...listeners.values()].some((listener) => safeEqual(listener.verifyToken, token));
    if (url.searchParams.get("hub.mode") === "subscribe" && known)
      return end(200, url.searchParams.get("hub.challenge") ?? "");
    return end(403);
  }
  if (request.method !== "POST") return end(405);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return end(413);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  let payload: { entry?: Array<{ changes?: Array<{ field?: string; value?: WhatsAppChangeValue }> }> };
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return end(400);
  }
  const values = (payload.entry ?? [])
    .flatMap((entry) => entry.changes ?? [])
    .filter((change) => change.field === "messages" && change.value !== undefined)
    .map((change) => change.value!);
  const routed = values.flatMap((value) => {
    const listener = listeners.get(value.metadata?.phone_number_id ?? "");
    return listener === undefined ? [] : [{ listener, value }];
  });
  // Every bot of one Meta app shares its secret; a payload for a bot must carry its signature.
  const signature = request.headers["x-hub-signature-256"];
  const header = Array.isArray(signature) ? signature[0] : signature;
  if (routed.some(({ listener }) => !validSignature(listener.appSecret, body, header))) return end(401);
  // Meta retries until it gets a 200, so answer first and handle the messages after.
  end(200);
  for (const { listener, value } of routed) listener.onValue(value);
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && Crypto.timingSafeEqual(a, b);
}
