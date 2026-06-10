// Category detection for DealScan.
//
// Lightweight keyword matching against the listing title + description.
// The category feeds two things: a hint line in the Claude prompt (so it
// applies the right evaluation lens) and the history filter in the UI.

const CATEGORY_KEYWORDS = {
  vehicles: [
    "car", "truck", "suv", "sedan", "coupe", "miles", "mileage", "odometer",
    "honda", "toyota", "ford", "chevy", "chevrolet", "nissan", "jeep", "bmw",
    "mercedes", "subaru", "hyundai", "kia", "motorcycle", "scooter", "atv",
  ],
  electronics: [
    "iphone", "samsung", "pixel", "macbook", "laptop", "desktop", "monitor",
    "tv", "television", "playstation", "ps5", "ps4", "xbox", "nintendo",
    "switch", "ipad", "tablet", "camera", "gpu", "graphics card", "headphones",
    "airpods", "speaker", "drone", "kindle",
  ],
  furniture: [
    "couch", "sofa", "sectional", "table", "desk", "chair", "dresser",
    "bookshelf", "shelf", "bed frame", "mattress", "nightstand", "cabinet",
    "ottoman", "recliner", "ikea", "west elm", "pottery barn", "wayfair",
  ],
  appliances: [
    "refrigerator", "fridge", "washer", "dryer", "dishwasher", "microwave",
    "oven", "stove", "freezer", "air conditioner", "vacuum", "blender",
  ],
  clothing: [
    "jacket", "coat", "shoes", "sneakers", "boots", "dress", "jeans", "shirt",
    "hoodie", "nike", "adidas", "jordan", "size m", "size l", "size s",
  ],
  sports: [
    "bike", "bicycle", "treadmill", "weights", "dumbbell", "kayak", "golf",
    "snowboard", "ski", "surfboard", "fishing", "tent", "camping", "peloton",
  ],
  tools: [
    "drill", "saw", "dewalt", "milwaukee", "makita", "ryobi", "tool box",
    "lawn mower", "mower", "generator", "pressure washer", "ladder",
  ],
  baby_kids: [
    "stroller", "crib", "car seat", "high chair", "baby", "toddler", "kids",
    "toys", "lego", "playset",
  ],
};

/**
 * Detect a listing's category from its text.
 * @param {string} text - title + description, any case.
 * @returns {string} category key, or "other".
 */
export function detectCategory(text) {
  if (!text) return "other";
  const haystack = text.toLowerCase();

  let bestCategory = "other";
  let bestHits = 0;
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const hits = keywords.filter((kw) => haystack.includes(kw)).length;
    if (hits > bestHits) {
      bestHits = hits;
      bestCategory = category;
    }
  }
  return bestCategory;
}

/** Human-readable label for a category key. */
export function categoryLabel(category) {
  const labels = {
    vehicles: "Vehicles",
    electronics: "Electronics",
    furniture: "Furniture",
    appliances: "Appliances",
    clothing: "Clothing",
    sports: "Sports & Outdoors",
    tools: "Tools & Garden",
    baby_kids: "Baby & Kids",
    other: "Other",
  };
  return labels[category] ?? "Other";
}

/** All category keys, for building filter dropdowns. */
export const ALL_CATEGORIES = [...Object.keys(CATEGORY_KEYWORDS), "other"];
