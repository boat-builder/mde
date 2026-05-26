import { forwardRef, useImperativeHandle, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

export type EditorHandle = {
  getMarkdown: () => string;
};

type Props = {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
};

function MilkdownInner({
  initialMarkdown,
  onChange,
  handleRef,
}: Props & { handleRef: React.MutableRefObject<EditorHandle | null> }) {
  const crepeRef = useRef<Crepe | null>(null);

  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: initialMarkdown,
      featureConfigs: {
        placeholder: {
          text: "Type / for commands…",
          mode: "doc",
        },
      },
    });
    crepe.on((api) => {
      api.markdownUpdated((_ctx, markdown) => {
        onChange(markdown);
      });
    });
    crepeRef.current = crepe;
    handleRef.current = {
      getMarkdown: () => crepe.getMarkdown(),
    };
    return crepe;
  }, []);

  return <Milkdown />;
}

const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const handleRef = useRef<EditorHandle | null>(null);
  useImperativeHandle(ref, () => ({
    getMarkdown: () => handleRef.current?.getMarkdown() ?? "",
  }));
  return (
    <MilkdownProvider>
      <MilkdownInner {...props} handleRef={handleRef} />
    </MilkdownProvider>
  );
});

export default Editor;
