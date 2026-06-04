// CriticMarkup editorial comments — Milkdown (ProseMirror) plugins.
//
// Two plugins, both built the same way the search plugin is (see
// src/searchPlugin.ts):
//
//   criticDecorationPlugin — renders the literal `{==..==}{>>..<<}` text as a
//     highlight with the brace delimiters collapsed, so the working syntax reads
//     as a comment affordance instead of raw braces. The text stays in the doc,
//     so markdown round-trips losslessly.
//
//   criticCopyPlugin — intercepts copy/cut so the clipboard gets the *clean*
//     markdown (markers stripped). The verbatim "with comments" copy is a
//     separate explicit action in the app's Settings menu.

import { $prose } from "@milkdown/kit/utils";
import { serializerCtx, schemaCtx } from "@milkdown/kit/core";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode, Schema } from "@milkdown/kit/prose/model";
import { findCommentRanges, stripComments } from "./criticMarkup";

// Build the decoration set for the whole doc by scanning every text node for
// comment markers (same shape as searchPlugin's findMatches + buildDecorations).
function buildDecorations(doc: ProseNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return undefined;
    for (const r of findCommentRanges(node.text)) {
      const syntax = (range: [number, number]) =>
        Decoration.inline(pos + range[0], pos + range[1], { class: "critic-syntax" });
      decos.push(syntax(r.openHl), syntax(r.closeHl), syntax(r.openCm), syntax(r.closeCm));
      decos.push(
        Decoration.inline(pos + r.highlight[0], pos + r.highlight[1], {
          class: "critic-highlight",
          // Native tooltip — hovering the highlight surfaces the comment text.
          title: r.commentText,
        }),
      );
      decos.push(
        Decoration.inline(pos + r.comment[0], pos + r.comment[1], { class: "critic-comment" }),
      );
    }
    return undefined;
  });
  return decos.length === 0 ? DecorationSet.empty : DecorationSet.create(doc, decos);
}

export const criticDecorationPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("mde-critic-decoration"),
      props: {
        decorations(state) {
          return buildDecorations(state.doc);
        },
      },
    }),
);

// Serialize the current selection to markdown exactly the way Milkdown's own
// clipboard plugin does (@milkdown/plugin-clipboard), so a copied span comes out
// as the same markdown it would normally — then we strip the comment markers.
function selectionMarkdown(
  view: EditorView,
  serializer: (doc: ProseNode) => string,
  schema: Schema,
): string {
  const slice = view.state.selection.content();
  const doc = schema.topNodeType.createAndFill(undefined, slice.content);
  if (!doc) return slice.content.textBetween(0, slice.content.size, "\n\n");
  return serializer(doc);
}

export const criticCopyPlugin = $prose((ctx) => {
  // Shared handler for copy and cut: put clean markdown on the clipboard. `cut`
  // additionally deletes the selection (we've taken over the default). The
  // serializer/schema are read lazily here (as Milkdown's own clipboard plugin
  // does) so we never hold a stale reference.
  const handle = (view: EditorView, event: ClipboardEvent, isCut: boolean): boolean => {
    if (view.state.selection.empty) return false;
    const data = event.clipboardData;
    if (!data) return false;
    const serializer = ctx.get(serializerCtx);
    const schema = ctx.get(schemaCtx);
    const clean = stripComments(selectionMarkdown(view, serializer, schema));
    // Markdown's canonical clipboard form is text/plain; leaving text/html empty
    // makes paste targets (including Milkdown's own handlePaste) fall back to it.
    data.setData("text/plain", clean);
    event.preventDefault();
    if (isCut) view.dispatch(view.state.tr.deleteSelection());
    return true;
  };

  return new Plugin({
    key: new PluginKey("mde-critic-copy"),
    props: {
      handleDOMEvents: {
        copy: (view, event) => handle(view, event, false),
        cut: (view, event) => handle(view, event, true),
      },
    },
  });
});
