// db/index.ts
import 'dotenv/config';

import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Limit connections to keep memory usage low on Render's free tier.
  max: 3,
});

export default pool;
