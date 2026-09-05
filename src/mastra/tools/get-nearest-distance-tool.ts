import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { geocodeAddress, getDistanceFromLatLonInKm } from "../../utils/geocode.js";
import { BRANCHES } from "../../db/branch-seed.js";
import { console } from "inspector/promises";



    // <strict_tool_enforcement>
    //   - AMNESIA RULE: You have absolutely ZERO internal knowledge of FBNBank branch locations, addresses, or distances. You do not know where any branches are located.
    //   - If a user asks for a branch, an agency, or provides a location, you MUST trigger the findNearestBranchTool tool. 
    //   - It is physically impossible for you to provide accurate branch information without the JSON output of this tool. If you attempt to answer without calling the tool, you are providing fake or INVALID information to the customer.
    //   - Never claim you used a tool if you did not actually execute the backend function in that exact turn.
    // </strict_tool_enforcement>

export const findNearestBranchTool = createTool({
  id: "find-nearest-branch",
  description:
    "Use this tool whenever a user asks for branch locations, nearest agencies, or shares their location.",
  
  inputSchema: z.object({
    latitude: z.number().optional().describe("The latitude if the user shared a GPS location"),
    longitude: z.number().optional().describe("The longitude if the user shared a GPS location"),
    address: z.string().optional().describe("The text address if the user typed their location"),
  }),
  // FIX: Make fields optional and add the error property
  outputSchema: z.object({
    nearestBranch: z.array(z.object({
      name: z.string(),
      address: z.string(),
      lat: z.number(),
      lng: z.number(),
      distanceKm: z.number(),
    })).optional(),
    searchedLocation: z.object({
      latitude: z.number(),
      longitude: z.number(),
    }).optional(),
    error: z.string().optional(),
  }),

  execute: async (input, context) => {
    const { latitude, longitude, address } = input;

    console.log("Received input for find-nearest-branch tool:", { latitude, longitude, address });
    
    let searchLat = latitude;
    let searchLng = longitude;

    if (address && (!latitude || !longitude)) {
        const geocodeResult = await geocodeAddress(address);

        console.log("Geocode result for address:", geocodeResult);

        if (!geocodeResult) {
          return {
              error: `Could not find coordinates for address: ${address}`,
          };
        }

        searchLat = geocodeResult.lat;
        searchLng = geocodeResult.lng;
    }

    if (searchLat == null || searchLng == null) {
        return {
            error: "Could not determine coordinates from the provided location.",
        };
    }

    const branchesWithDistance = BRANCHES
        .map((branch) => ({
        ...branch,
        distanceKm: getDistanceFromLatLonInKm(
            searchLat,
            searchLng,
            branch.lat,
            branch.lng
        ),
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
    
    console.log("Branches with calculated distances:", branchesWithDistance);

    const nearestBranches = branchesWithDistance[0] ? [branchesWithDistance[0]] : [];

    const result = {
        nearestBranch: nearestBranches,
        searchedLocation: {
            latitude: searchLat,
            longitude: searchLng,
        },
    };


    console.log("Nearest branches:", result);

    return result;
  },
});
