// One Realtime round trip, for scripts/preflight.py: subscribe to the INSERT of one submission (by its
// client id), say so, and print the moment it arrives.
//
//   node --env-file=.env.local scripts/realtime-roundtrip.mjs <client_submission_id> [timeout seconds]
//
// Prints "subscribed <epoch ms>", then "event <epoch ms>"; exits 1 on a timeout or a channel error.
import { createClient } from "@supabase/supabase-js";

const [clientId, timeout = "25"] = process.argv.slice(2);
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const stop = async (code) => {
  await supabase.removeAllChannels();
  process.exit(code);
};
setTimeout(() => {
  console.log("timeout");
  void stop(1);
}, Number(timeout) * 1000);

supabase
  .channel(`preflight-${clientId}`)
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "submissions", filter: `client_submission_id=eq.${clientId}` }, () => {
    console.log(`event ${Date.now()}`);
    void stop(0);
  })
  .subscribe((status) => {
    if (status === "SUBSCRIBED") console.log(`subscribed ${Date.now()}`);
    else if (status !== "CLOSED") {
      console.log(`channel ${status}`);
      void stop(1);
    }
  });
