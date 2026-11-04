-- 0012: re-send a lost job hook after 10 s instead of 30 s.
--
-- An arrival's jobs now start three ways: the API runs them itself right after the
-- ingest response (jobs.start_now), the database hook POSTs each new job (0007), and
-- this sweep re-sends the hook for a job still queued. pg_net 0.20.4 has no option to
-- use HTTP/1.1, and about 2% of its deliveries to Vercel fail with "Error in the HTTP2
-- framing layer" (5 of 219 over six hours, round 13 testing), so the sweep is the last
-- net; every 10 s, for jobs queued at least 10 s, it bounds a doubly lost start at
-- about 20 s. A job is claimed once, so a repeat stays harmless.

select cron.schedule('resend-stale-job-hooks', '10 seconds', 'select public.resend_stale_job_hooks(10)');
