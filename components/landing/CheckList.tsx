"use client";

import { useId, useState } from "react";

import { Chevron, Reveal } from "@/components/ui/Disclosure";
import { CHECK_ORDER, CHECK_TITLE } from "@/lib/checks";

/** The landing card's "which checks?": the ten checks, behind a disclosure. */
export function CheckList() {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button type="button" className="disclosure text-[12.5px] text-accent-ink" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Chevron />
        Which checks?
      </button>
      <Reveal open={open} id={id}>
        <p className="pt-1.5 text-[12.5px]">{CHECK_ORDER.map((k) => CHECK_TITLE[k]).join(" · ")}.</p>
      </Reveal>
    </div>
  );
}
