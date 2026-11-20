/**
 * A WhatsApp text message holds 4,096 characters. Chunks are cut from the markdown before it
 * is converted, with room left because links grow when written out.
 */
export const WHATSAPP_MESSAGE_LIMIT = 3500;
/** The body of an interactive (button or list) message holds 1,024 characters. */
export const WHATSAPP_INTERACTIVE_BODY_LIMIT = 1024;

const BOLD = "\u0001";

/**
 * Converts common markdown to WhatsApp's own formatting: *bold*, _italic_, ~strike~,
 * `code` and ```blocks```. WhatsApp has no headings, links or tables: headings become bold
 * lines, links are written out, and tables go into a ``` block so their columns line up.
 */
export function toWhatsApp(markdown: string): string {
  return markdown
    .split(/(```[^\n]*\n[\s\S]*?```)/g)
    .map((part) => {
      const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(part);
      if (fence !== null) return "```\n" + fence[1] + "\n```";
      return part
        .split(/((?:^\|.*\|[ \t]*(?:\n|$))+)/m)
        .map((piece) => (/^\|.*\|/.test(piece) ? "```\n" + piece.replace(/\n$/, "") + "\n```\n" : inline(piece)))
        .join("");
    })
    .join("");
}

function inline(text: string): string {
  // Inline code is left alone; everything between is converted.
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part, index) => (index % 2 === 1 ? part : convert(part)))
    .join("");
}

function convert(text: string): string {
  return text
    .replace(/^(\s*)[*+]\s+/gm, "$1- ")
    .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, (_, heading: string) => `${BOLD}${heading.replace(/\*\*/g, "")}${BOLD}`)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt: string, url: string) => (alt ? `${alt} (${url})` : url))
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label: string, url: string) =>
      label === url || label === url.replace(/^\w+:\/\//, "") ? url : `${label} (${url})`,
    )
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/__(.+?)__/g, `${BOLD}$1${BOLD}`)
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, "$1_$2_")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replaceAll(BOLD, "*");
}
