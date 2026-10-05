import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Running time the host saw each cube spend, per UTC hour. Cubes keep no
  // history of their own, and a deleted cube's time still counts.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cube_usage (
      hour_start TEXT NOT NULL,
      cube_id TEXT NOT NULL,
      backend TEXT NOT NULL,
      label TEXT NOT NULL,
      running_seconds INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      PRIMARY KEY (hour_start, cube_id)
    ) WITHOUT ROWID
  `;
});
