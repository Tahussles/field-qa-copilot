import type { ComponentProps, ElementType } from "react";

type GlassProps<T extends ElementType> = { as?: T } & ComponentProps<T>;

/** The floating layer only: bars, overlays, chips, tooltips, toasts, modals. See .glass in globals.css. */
export function Glass<T extends ElementType = "div">({ as, className = "", ...rest }: GlassProps<T>) {
  const Component = as ?? "div";
  return <Component className={`glass ${className}`} {...rest} />;
}
