// db/branch.repository.ts
import pool from "./index.js";

export async function upsertBranch(branch: {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  geocodedAddress?: string;
}) {
  await pool.query(
    `
    INSERT INTO branches (
      name,
      address,
      latitude,
      longitude,
      geocoded_address
    )
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT(name)
    DO UPDATE SET
      address = EXCLUDED.address,
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      geocoded_address = EXCLUDED.geocoded_address,
      updated_at = NOW()
    `,
    [
      branch.name,
      branch.address,
      branch.latitude,
      branch.longitude,
      branch.geocodedAddress,
    ]
  );
}

export async function getAllBranches() {
  const result = await pool.query(`
    SELECT
      name,
      address,
      latitude,
      longitude
    FROM branches
  `);

  return result.rows;
}
