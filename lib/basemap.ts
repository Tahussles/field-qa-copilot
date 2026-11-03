// The map palette shared by the dashboard map and the landing page's pre-rendered
// basemap (scripts/render-basemap.mjs imports this file and runs tuneBasemap in the
// page it renders). Plain functions only: the script runs them via toString().

import type { Map as MlMap } from "maplibre-gl";

// OpenFreeMap: free vector tiles, no API key. Attribution comes from the tile source.
// The linear theme recolours the dark style; the poket theme recolours the light Positron style.
export const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
export const LIGHT_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/** Recolour OpenFreeMap's dark style to the prototype's map palette. */
export function tuneBasemap(map: MlMap) {
  const paint = (id: string, prop: string, value: unknown) => {
    try {
      (map.setPaintProperty as (layer: string, name: string, v: unknown) => void).call(map, id, prop, value);
    } catch {
      // layer without that property
    }
  };
  for (const layer of map.getStyle().layers ?? []) {
    const id = layer.id;
    if (layer.type === "background") paint(id, "background-color", "#0b0c0f");
    else if (id === "water") paint(id, "fill-color", "#131823"); // rgba(90,130,210,.10) over the map ground
    else if (id === "waterway") paint(id, "line-color", "#1a2130");
    else if (id === "building") {
      paint(id, "fill-color", "#0d0e11");
      paint(id, "fill-outline-color", "#121317");
    } else if (layer.type === "fill") paint(id, "fill-color", "#0c0d10");
    else if (layer.type === "line" && id.startsWith("highway")) {
      paint(id, "line-color", id.includes("major") || id.includes("motorway") || id.includes("trunk") ? "#1e1f23" : "#151619");
    } else if (layer.type === "line") paint(id, "line-color", "#141518");
    else if (/^place_(other|suburb|village)$/.test(id)) {
      // Real neighbourhood names would sit next to our survey area labels.
      map.setLayoutProperty(id, "visibility", "none");
    } else if (layer.type === "symbol") {
      paint(id, "text-color", "#54565b");
      paint(id, "text-halo-color", "#0b0c0f");
    }
  }
}

/** Recolour OpenFreeMap's Positron style for the poket theme: a pale green-grey ground, soft blue water
 * and white roads, quiet enough that amber and red points and the hotspot rings stand out. */
export function tuneLightBasemap(map: MlMap) {
  const paint = (id: string, prop: string, value: unknown) => {
    try {
      (map.setPaintProperty as (layer: string, name: string, v: unknown) => void).call(map, id, prop, value);
    } catch {
      // layer without that property
    }
  };
  for (const layer of map.getStyle().layers ?? []) {
    const id = layer.id;
    if (layer.type === "background") paint(id, "background-color", "#f1f3ef");
    else if (id === "water") paint(id, "fill-color", "#d3e3ea");
    else if (id === "waterway") paint(id, "line-color", "#c3d6df");
    else if (id === "park") paint(id, "fill-color", "#e2ede4");
    else if (id === "landcover_wood") paint(id, "fill-color", "#e1e9e1");
    else if (id === "landuse_residential") paint(id, "fill-color", "#eceee9");
    else if (id === "building") {
      paint(id, "fill-color", "#e6e8e3");
      paint(id, "fill-outline-color", "#d8dbd4");
    } else if (/^label_(other|village)$/.test(id) || id.includes("shield")) {
      // Real neighbourhood names would sit next to our survey area labels, and road shields
      // (white boxes) compete with the points; the dark style draws neither.
      map.setLayoutProperty(id, "visibility", "none");
    } else if (layer.type === "symbol") {
      paint(id, "text-color", "#6b7068");
      paint(id, "text-halo-color", "#f1f3ef");
    }
  }
}
