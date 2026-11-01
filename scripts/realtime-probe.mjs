// Prints Realtime inserts and updates on submissions and scores, using the
// public (publishable) key, to prove the dashboard can update live.
//
//   node --env-file=.env.local scripts/realtime-probe.mjs [seconds]
//
// With no argument it runs until Ctrl-C.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
  process.exit(1);
}

const seconds = Number(process.argv[2] ?? 0);
const supabase = createClient(url, key);
const counts = {};
const time = () => new Date().toISOString().slice(11, 23);

function describe(table, row) {
  if (table === "scores") {
    return `${row.submission_id?.slice(0, 8)} score ${row.score} flagged ${row.flagged} v${row.engine_version}`;
  }
  if (row.source === undefined) return `${row.id?.slice(0, 8)}`; // deletes carry only the key
  return `${row.id?.slice(0, 8)} source ${row.source} captured ${row.captured_at}`;
}

function print({ table, eventType, new: fresh, old }) {
  const row = fresh && Object.keys(fresh).length ? fresh : old;
  const name = `${table} ${eventType}`;
  counts[name] = (counts[name] ?? 0) + 1;
  console.log(`${time()}  ${table.padEnd(11)} ${eventType.padEnd(6)} ${describe(table, row)}`);
}

supabase
  .channel("realtime-probe")
  .on("postgres_changes", { event: "*", schema: "public", table: "submissions" }, print)
  .on("postgres_changes", { event: "*", schema: "public", table: "scores" }, print)
  .subscribe((status) => console.log(`${time()}  channel ${status}`));

async function stop() {
  console.log(`${time()}  totals ${JSON.stringify(counts)}`);
  await supabase.removeAllChannels();
  process.exit(0);
}

process.on("SIGINT", stop);
if (seconds > 0) setTimeout(stop, seconds * 1000);
