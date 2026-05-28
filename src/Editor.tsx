import { Crepe } from "@milkdown/crepe";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

type Props = {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
};

function MilkdownInner({ initialMarkdown, onChange }: Props) {
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
    return crepe;
  }, []);

  return <Milkdown />;
}

export default function Editor(props: Props) {
  return (
    <MilkdownProvider>
      <MilkdownInner {...props} />
    </MilkdownProvider>
  );
}
