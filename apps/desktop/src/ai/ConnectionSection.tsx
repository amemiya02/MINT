import { type ReactNode, useId, useState } from "react";

export function ConnectionSection({
  title,
  children,
  preserveContent = false,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly preserveContent?: boolean;
}) {
  const [disclosure, setDisclosure] = useState<"initial" | "open" | "closed">("initial");
  const open = disclosure === "open";
  const sectionId = useId();
  return (
    <section className="rounded-md border border-(--mint-border)">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={sectionId}
        onClick={() => setDisclosure(open ? "closed" : "open")}
        className="w-full rounded-md px-3 py-2 text-start text-sm font-medium hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
      >
        {title}
      </button>
      <div id={sectionId} hidden={!open}>
        {(open || (preserveContent && disclosure === "closed")) && children}
      </div>
    </section>
  );
}
