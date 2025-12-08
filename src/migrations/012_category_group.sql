ALTER TABLE bills
ADD COLUMN IF NOT EXISTS category_group TEXT;

UPDATE bills
SET category_group = CASE
  WHEN LOWER(COALESCE(category, '')) IN ('fabric','sampling','manufacturing','stitching','packaging','logistics','vendor')
    THEN 'COGS'
  WHEN LOWER(COALESCE(category, '')) IN ('marketing','ads')
    THEN 'MARKETING'
  WHEN LOWER(COALESCE(category, '')) IN ('admin','salary','hr')
    THEN 'ADMIN'
  ELSE 'OPERATING'
END;
