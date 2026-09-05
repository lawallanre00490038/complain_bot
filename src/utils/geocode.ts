
import { z } from "zod";



export async function geocodeAddress(address: string) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(
        address
    )}&limit=1`;


    console.log("Testing URL:", url);
    
    const response = await fetch(url, {
        headers: {
        "User-Agent": "FBNBank-Agent/1.0",
        "Accept": "application/json",
        },
    });

    if (!response.ok) {
        throw new Error(`Geocoding failed: ${response.status}`);
    }

    const NominatimSchema = z.array(
        z.object({
            lat: z.string(),
            lon: z.string(),
            display_name: z.string(),
        })
    );

    const results = NominatimSchema.parse(await response.json());

    if (results.length === 0) {
        return null;
    }

    const result = {
        lat: Number(results[0].lat),
        lng: Number(results[0].lon),
        displayName: results[0].display_name,
    };

    console.log("Geocode result:", result);

    return result;
}


// Helper function to calculate distance (Haversine formula)
export function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}
