"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Enter opens the app, as in the prototype (unless a link, button or field has focus). */
export function OpenOnEnter() {
  const router = useRouter();
  useEffect(() => {
    router.prefetch("/app");
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("a, button, input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      router.push("/app");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return null;
}
