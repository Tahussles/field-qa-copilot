# Rolling production back

Use this when a deploy breaks the demo. It takes under a minute, needs only a browser signed in to Vercel, and traffic moves to the previous build without rebuilding anything.

## Steps

1. Open the project: <https://vercel.com/tahoi-goooooooooooos-projects/field-qa-copilot>
2. On the **Production Deployment** tile, click **Instant Rollback**.
3. In the dialog, select the previous production deployment.
4. Click **Confirm Rollback**.
5. Check which commit is live:

   ```bash
   curl -s https://field-qa-copilot.vercel.app/api/py/health
   ```

   `commit` should now be the previous deployment's, and `writes` should still be `true`.

Another way in: the **Deployments** tab, filtered to `main`, then **⋮** on the row, then **Instant Rollback**.

## What to know

- **One step back only.** The Hobby plan can roll back to the immediately previous production deployment, not further. An older deployment is refused, and `v1.2-demo`'s deployment is not eligible.
- **New pushes stop going live.** After a rollback, Vercel turns off auto-assignment of production domains, so a push to `main` won't replace the rolled-back deployment until you undo it.
- **The database stays as it is.** A rollback swaps the app build only. The last migration (0012) changed a cron schedule, not the schema, so the previous build runs on the current database.
- **Environment variables come from the old build.** Variables changed in project settings since that build don't apply until you undo the rollback.
- **`/prototype` may go.** The route doesn't exist in builds before it was added, so it returns 404 if you roll back past that point.
- **post-deploy doesn't run on a rollback**, and `pnpm preflight` reports a red commit mismatch against `origin/main`. Both are expected.

## Undo the rollback

On the project overview, click **Undo Rollback** on the Production Deployment tile, select the deployment to restore, and click **Confirm**. That also turns auto-assignment back on, so new pushes go live again.

## After either change

Reset the demo so production starts from the fresh wave:

```bash
curl -fsS -X POST https://field-qa-copilot.vercel.app/api/py/demo/reset -H "X-Demo-Passcode: $DEMO_PASSCODE"
```

The same reset is in the demo panel: press D, then **Reset demo**.
