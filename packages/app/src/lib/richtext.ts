/**
 * tldraw stores shape text as rich text — a ProseMirror/tiptap document
 * (`{ type: "doc", content: [...] }`). These helpers bridge to/from plain text
 * for the bridge `list_shapes` summaries.
 */

interface RichNode {
  type?: string;
  text?: string;
  content?: RichNode[];
}

/** Extract plain text from a tldraw rich-text value, joining paragraphs with newlines. */
export function plainTextFromRichText(rt: unknown): string {
  if (!rt || typeof rt !== "object") return "";
  const lines: string[] = [];

  const walkBlock = (node: RichNode): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "paragraph" || node.type === "heading") {
      lines.push(inlineText(node));
      return;
    }
    node.content?.forEach(walkBlock);
  };

  const inlineText = (node: RichNode): string => {
    if (typeof node.text === "string") return node.text;
    return (node.content ?? []).map(inlineText).join("");
  };

  const root = rt as RichNode;
  if (root.content) root.content.forEach(walkBlock);
  else lines.push(inlineText(root));

  return lines.join("\n").trim();
}
