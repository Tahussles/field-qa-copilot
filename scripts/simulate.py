"""Simulate phones syncing submissions to the API in real time.

Replays submissions with source='simulator' through the same ingest path a real
phone would use, including offline batches and retries that reuse a
client_submission_id, so the dashboard and Realtime feed can be exercised
end to end.
"""
