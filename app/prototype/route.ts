import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The approved design from the first session, byte for byte. Cached, so the build prerenders it as a static page.
async function design() {
  "use cache";
  return readFile(join(process.cwd(), "design", "prototype.html"), "utf8");
}

export async function GET() {
  return new Response(await design(), {
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow" },
  });
}
