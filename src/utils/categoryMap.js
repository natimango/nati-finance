const CATEGORY_MAP = {
  fabric: { key: 'fabric', group: 'COGS' },
  sampling: { key: 'sampling', group: 'COGS' },
  manufacturing: { key: 'manufacturing', group: 'COGS' },
  stitching: { key: 'stitching', group: 'COGS' },
  packaging: { key: 'packaging', group: 'COGS' },
  logistics: { key: 'logistics', group: 'COGS' },
  vendor: { key: 'vendor', group: 'COGS' },
  // Operating
  rent: { key: 'rent', group: 'OPERATING' },
  utilities: { key: 'utilities', group: 'OPERATING' },
  travel: { key: 'travel', group: 'OPERATING' },
  transportation: { key: 'travel', group: 'OPERATING' },
  food: { key: 'food_meals', group: 'OPERATING' },
  meals: { key: 'food_meals', group: 'OPERATING' },
  food_meals: { key: 'food_meals', group: 'OPERATING' },
  tech: { key: 'tech', group: 'OPERATING' },
  software: { key: 'tech', group: 'OPERATING' },
  office: { key: 'office', group: 'OPERATING' },
  admin: { key: 'admin', group: 'ADMIN' },
  salary: { key: 'salary', group: 'ADMIN' },
  hr: { key: 'hr', group: 'ADMIN' },
  marketing: { key: 'marketing', group: 'MARKETING' },
  ads: { key: 'ads', group: 'MARKETING' },
  misc: { key: 'misc', group: 'OPERATING' }
};

const DEFAULT_GROUP = 'OPERATING';

function normalizeCategory(rawCategory) {
  if (!rawCategory) {
    return { category: 'misc', category_group: DEFAULT_GROUP };
  }
  const key = rawCategory.toString().toLowerCase().trim();
  if (CATEGORY_MAP[key]) {
    return {
      category: CATEGORY_MAP[key].key,
      category_group: CATEGORY_MAP[key].group
    };
  }
  // fallbacks for combined values like "food & meals"
  if (key.includes('food') || key.includes('meal')) {
    return { category: 'food_meals', category_group: 'OPERATING' };
  }
  if (key.includes('travel') || key.includes('flight') || key.includes('cab')) {
    return { category: 'travel', category_group: 'OPERATING' };
  }
  if (key.includes('fabric') || key.includes('textile')) {
    return { category: 'fabric', category_group: 'COGS' };
  }
  if (key.includes('marketing') || key.includes('ad')) {
    return { category: 'marketing', category_group: 'MARKETING' };
  }
  if (key.includes('packag')) {
    return { category: 'packaging', category_group: 'COGS' };
  }
  if (key.includes('logist') || key.includes('ship')) {
    return { category: 'logistics', category_group: 'COGS' };
  }
  return { category: key || 'misc', category_group: DEFAULT_GROUP };
}

module.exports = {
  normalizeCategory
};
