import { forwardRef, useImperativeHandle, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  searchKey,
  searchPlugin,
  getSearchState,
  type SearchInfo,
  type SearchMeta,
} from "./searchPlugin";
import { criticDecorationPlugin, criticCopyPlugin } from "./criticPlugin";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

// Imperative handle the host (App) uses to drive in-file search. Setting the
// query is idempotent; next/prev advance the current match and scroll it into
// view. Calls made before the editor has mounted are buffered (see pendingRef).
export type EditorHandle = {
  setSearch: (query: string, caseSensitive: boolean) => void;
  searchNext: () => void;
  searchPrev: () => void;
  clearSearch: () => void;
};

type Props = {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  onSearchState?: (info: SearchInfo) => void;
};

function dispatchMeta(view: EditorView, meta: SearchMeta) {
  view.dispatch(view.state.tr.setMeta(searchKey, meta));
}

// Speech-bubble icon for the selection-toolbar "Comment" button. Crepe renders
// the toolbar icon from a raw SVG string (same as its built-in bold/italic).
const commentIcon = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </svg>
`;

// Wrap the current selection as a CriticMarkup comment: {==selected==}{>>...<<}
// then drop the caret inside the (empty) comment so the user types it straight
// away. No-op on an empty selection — there's nothing to comment on.
function wrapSelectionAsComment(ctx: Ctx) {
  const view = ctx.get(editorViewCtx);
  const { from, to, empty } = view.state.selection;
  if (empty) return;
  const selected = view.state.doc.textBetween(from, to);
  const prefix = `{==${selected}==}{>>`;
  const wrapped = `${prefix}<<}`;
  const tr = view.state.tr.insertText(wrapped, from, to);
  // Caret position is `from + prefix.length` — just after `{>>`, before `<<}`.
  const caret = from + prefix.length;
  tr.setSelection(TextSelection.create(tr.doc, caret));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function infoOf(view: EditorView): SearchInfo {
  const s = getSearchState(view.state);
  return { count: s?.matches.length ?? 0, current: s?.current ?? 0 };
}

// Scroll the current match into view WITHOUT touching the editor selection, so
// the find-bar input keeps focus. We resolve the DOM node at the match position
// and scroll it; falls back silently if the position can't be mapped.
function scrollToCurrent(view: EditorView) {
  const s = getSearchState(view.state);
  if (!s || s.matches.length === 0) return;
  const m = s.matches[s.current];
  if (!m) return;
  try {
    const dom = view.domAtPos(m.from);
    const el =
      dom.node.nodeType === Node.TEXT_NODE
        ? dom.node.parentElement
        : (dom.node as HTMLElement);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch {
    // position may be momentarily invalid mid-edit; ignore
  }
}

const MilkdownInner = forwardRef<EditorHandle, Props>(function MilkdownInner(
  { initialMarkdown, onChange, onSearchState },
  ref,
) {
  const viewRef = useRef<EditorView | null>(null);
  // A search request that arrived before the editor mounted (e.g. opening a
  // workspace-search result remounts the editor, then the query is applied).
  const pendingRef = useRef<{ query: string; caseSensitive: boolean } | null>(null);
  // Callbacks captured in the (run-once) editor factory must read the latest
  // prop, so route them through refs.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSearchStateRef = useRef(onSearchState);
  onSearchStateRef.current = onSearchState;

  const report = () => {
    const view = viewRef.current;
    if (view) onSearchStateRef.current?.(infoOf(view));
  };

  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: initialMarkdown,
      featureConfigs: {
        placeholder: {
          text: "Type / for commands…",
          mode: "doc",
        },
        toolbar: {
          // Add a "Comment" button to the selection toolbar (its own group so we
          // don't depend on a built-in group key).
          buildToolbar: (builder) => {
            builder.addGroup("critic-markup", "Comment").addItem("comment", {
              icon: commentIcon,
              active: () => false,
              onRun: wrapSelectionAsComment,
            });
          },
        },
      },
    });
    crepe.editor.use(searchPlugin);
    crepe.editor.use(criticDecorationPlugin);
    crepe.editor.use(criticCopyPlugin);
    crepe.on((api) => {
      api.markdownUpdated((_ctx, markdown) => {
        onChangeRef.current(markdown);
      });
      api.mounted((ctx) => {
        const view = ctx.get(editorViewCtx);
        viewRef.current = view;
        const pending = pendingRef.current;
        if (pending) {
          pendingRef.current = null;
          dispatchMeta(view, { kind: "set", ...pending });
          scrollToCurrent(view);
        }
        report();
      });
      // Keep the match count fresh as the user edits the document.
      api.updated(() => report());
    });
    return crepe;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      setSearch(query, caseSensitive) {
        const view = viewRef.current;
        if (!view) {
          pendingRef.current = { query, caseSensitive };
          return;
        }
        dispatchMeta(view, { kind: "set", query, caseSensitive });
        report();
        scrollToCurrent(view);
      },
      searchNext() {
        const view = viewRef.current;
        if (!view) return;
        dispatchMeta(view, { kind: "next" });
        report();
        scrollToCurrent(view);
      },
      searchPrev() {
        const view = viewRef.current;
        if (!view) return;
        dispatchMeta(view, { kind: "prev" });
        report();
        scrollToCurrent(view);
      },
      clearSearch() {
        pendingRef.current = null;
        const view = viewRef.current;
        if (!view) return;
        dispatchMeta(view, { kind: "clear" });
        report();
      },
    }),
    [],
  );

  return <Milkdown />;
});

const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  return (
    <MilkdownProvider>
      <MilkdownInner {...props} ref={ref} />
    </MilkdownProvider>
  );
});

export default Editor;
