import 'dotenv/config';
import { runSync } from '../api/_sync-core.js';

runSync()
  .then((r) => {
    r.tables.forEach((t) => console.log(`[done] ${t.table}: ${t.rows} rows`));
    r.skipped.forEach((t) => console.log(`[skip] ${t}: env var not set`));
    console.log(`Sync complete. ${r.total} rows in ${(r.elapsedMs / 1000).toFixed(1)}s`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
