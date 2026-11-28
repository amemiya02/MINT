import { type ReactNode, useId, useState } from "react";

export function ConnectionSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const sectionId = useId();
  return (
    <section className="rounded-md border border-(--mint-border)">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={sectionId}
        onClick={() => setOpen(!open)}
        className="w-full rounded-md px-3 py-2 text-start text-sm font-medium hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
      >
        {title}
      </button>
      <div id={sectionId} hidden={!open}>
        {open && children}
      </div>
    </section>
  );
}
