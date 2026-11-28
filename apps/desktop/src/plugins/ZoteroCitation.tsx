import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform, ZoteroPage } from "../platform/platform.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import { canCite } from "./host.ts";

interface Props {
  id: string;
  platform: Platform;
  granted: boolean;
  insert(text: string): boolean;
}

const button = "rounded border border-(--mint-border) px-2 py-1 text-sm hover:bg-(--mint-hover)";

export function ZoteroCitation(props: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={button} type="button" onClick={() => setOpen(true)}>
        {t("zotero.insert")}
      </button>
      {open && <Picker {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function Picker({ id, platform, granted, insert, onClose }: Props & { onClose(): void }) {
  const t = useT();
  const { props, close } = useModalDialog(onClose);
  const [start, setStart] = useState(0);
  const [page, setPage] = useState<ZoteroPage | null>(null);
  const [error, setError] = useState<
    "zotero.unavailable" | "zotero.denied" | "zotero.noDraft" | null
  >(null);
  useEffect(() => {
    let current = true;
    setPage(null);
    setError(null);
    if (granted && canCite(id)) {
      void platform.listZoteroItems(start).then(
        (result) => {
          if (current && canCite(id)) setPage(result);
        },
        () => {
          if (current) setError("zotero.unavailable");
        },
      );
    }
    return () => {
      current = false;
    };
  }, [id, platform, granted, start]);
  const failure = granted ? error : "zotero.denied";
  return (
    <dialog
      {...props}
      aria-label={t("zotero.insert")}
      className="m-auto max-h-[75vh] max-w-lg rounded border border-(--mint-border) bg-(--mint-bg) p-4 text-(--mint-fg) backdrop:bg-black/30"
    >
      <h2 className="mb-2 font-medium">{t("zotero.insert")}</h2>
      {failure ? (
        <p role="alert">{t(failure)}</p>
      ) : !page ? (
        <p>{t("zotero.loading")}</p>
      ) : (
        <>
          {page.items.length === 0 && <p>{t("zotero.empty")}</p>}
          <ul>
            {page.items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  className={button}
                  onClick={() => {
                    if (!canCite(id)) {
                      setError("zotero.denied");
                      return;
                    }
                    const title = item.title.replace(/[\\[\]*_`<>~]/g, "\\$&");
                    if (insert(`[${title}](zotero://select/library/items/${item.key})`)) close();
                    else setError("zotero.noDraft");
                  }}
                >
                  {item.title}
                </button>
              </li>
            ))}
          </ul>
          {start > 0 && (
            <button className={button} type="button" onClick={() => setStart(start - 50)}>
              {t("zotero.previous")}
            </button>
          )}
          {page.next && (
            <button className={button} type="button" onClick={() => setStart(start + 50)}>
              {t("zotero.more")}
            </button>
          )}
        </>
      )}
      <button className={button} type="button" onClick={close}>
        {t("settings.close")}
      </button>
    </dialog>
  );
}
