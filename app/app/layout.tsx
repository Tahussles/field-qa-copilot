import type { ReactNode } from "react";

import { AppShell } from "@/components/app/AppShell";

// Map style, tiles and glyphs come from OpenFreeMap; open the connection early.
// React hoists this <link> into <head>.
const TILE_HOST = "https://tiles.openfreemap.org";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link rel="preconnect" href={TILE_HOST} crossOrigin="anonymous" />
      <AppShell>{children}</AppShell>
    </>
  );
}
