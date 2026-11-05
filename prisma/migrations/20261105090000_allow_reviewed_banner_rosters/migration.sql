-- Extend field ownership without changing existing banner rows or publication values.
ALTER TABLE "BannerSourcePublication"
  DROP CONSTRAINT "BannerSourcePublication_fields_check",
  ADD CONSTRAINT "BannerSourcePublication_fields_check" CHECK (
    cardinality("ownedFields") BETWEEN 1 AND 4 AND
    "ownedFields" <@ ARRAY['NAME', 'SOURCE', 'TIMING', 'ROSTER']::TEXT[] AND
    array_position("ownedFields", NULL) IS NULL AND
    array_length(array_positions("ownedFields", 'NAME'), 1) IS NOT DISTINCT FROM CASE WHEN 'NAME'=ANY("ownedFields") THEN 1 ELSE NULL END AND
    array_length(array_positions("ownedFields", 'SOURCE'), 1) IS NOT DISTINCT FROM CASE WHEN 'SOURCE'=ANY("ownedFields") THEN 1 ELSE NULL END AND
    array_length(array_positions("ownedFields", 'TIMING'), 1) IS NOT DISTINCT FROM CASE WHEN 'TIMING'=ANY("ownedFields") THEN 1 ELSE NULL END AND
    array_length(array_positions("ownedFields", 'ROSTER'), 1) IS NOT DISTINCT FROM CASE WHEN 'ROSTER'=ANY("ownedFields") THEN 1 ELSE NULL END AND
    (NOT ('ROSTER'=ANY("ownedFields")) OR 'SOURCE'=ANY("ownedFields"))
  );
