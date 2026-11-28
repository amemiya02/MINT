import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { ModelTarget, SendModelMessage } from "./model.ts";

export interface VisionTarget {
  readonly id: string;
  readonly connection: ModelTarget;
  readonly apiKey?: string;
}

type Status = "checking" | "verified" | "failed";

export interface VisionCheck {
  readonly status?: Status;
  readonly verified: boolean;
  readonly run: () => void;
}

export function useModelVision(send: SendModelMessage) {
  const [checks, setChecks] = useState<ReadonlyMap<string, Status>>(() => new Map());
  const requests = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const running = requests.current;
    return () => {
      for (const controller of running.values()) controller.abort();
      running.clear();
    };
  }, []);

  return (target: VisionTarget | undefined): VisionCheck | undefined => {
    if (!target) return;
    const { id, connection, apiKey } = target;
    const status = checks.get(id);
    return {
      status,
      verified: status === "verified",
      run() {
        if (requests.current.has(id)) return;
        const controller = new AbortController();
        requests.current.set(id, controller);
        setChecks((previous) => new Map(previous).set(id, "checking"));
        void checkSample(send, connection, apiKey, controller.signal).then((verified) => {
          if (controller.signal.aborted) return;
          requests.current.delete(id);
          setChecks((previous) => new Map(previous).set(id, verified ? "verified" : "failed"));
        });
      },
    };
  };
}

async function checkSample(
  send: SendModelMessage,
  connection: ModelTarget,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const sample = document.createElement("canvas");
    sample.width = 192;
    sample.height = 96;
    const drawing = sample.getContext("2d");
    if (!drawing) return false;
    drawing.fillStyle = "#00bc00";
    drawing.fillRect(0, 0, 96, 96);
    drawing.fillStyle = "#ffff00";
    drawing.fillRect(96, 0, 96, 96);
    const reply = await send(
      connection,
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Name the two colors in this sample image from left to right. Reply with just two basic English color names separated by a comma.",
            },
            { type: "image_url", image_url: { url: sample.toDataURL("image/png") } },
          ],
        },
      ],
      { apiKey, signal },
    );
    return (
      (reply.finishReason === null || reply.finishReason === "stop") &&
      /^green\s*,\s*yellow\.?$/i.test(reply.text.trim())
    );
  } catch {
    return false;
  }
}

export function VisionControl({ check }: { readonly check: VisionCheck }) {
  const t = useT();
  if (check.status === "verified") return <p role="status">{t("materials.visionVerified")}</p>;
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) disabled:opacity-50"
        disabled={check.status === "checking"}
        onClick={check.run}
      >
        {t("materials.checkVision")}
      </button>
      <p className="text-(--mint-muted)">{t("materials.visionSample")}</p>
      {check.status && <p role="status">{t(`materials.vision.${check.status}`)}</p>}
    </div>
  );
}
