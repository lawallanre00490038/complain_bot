// scripts/geocodeBranches.ts

import { upsertBranch } from "../db/branch.repository.js";
import { BRANCHES } from "./branch-seed.js";

export async function geocodeAndStoreBranches() {
  for (const branch of BRANCHES) {
    try {
      // We skip the API call and use the hardcoded coordinates from branch-seed.js
      await upsertBranch({
        name: branch.name,
        address: branch.address,
        latitude: branch.lat, 
        longitude: branch.lng,
        geocodedAddress: branch.address, // We just use the provided address string here
      });

      console.log(`✅ Saved ${branch.name}: ${branch.lat}, ${branch.lng}`);
    } catch (err) {
      console.error(`❌ Failed to save ${branch.name}`, err);
    }
  }
}
