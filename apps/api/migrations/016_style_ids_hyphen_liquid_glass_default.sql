-- Style ids may contain a hyphen ('liquid-glass'): the shape checks of 015 allowed lowercase letters only, so a person could
-- not keep that style on the server and an admin could not make it the organization default. The real list is still checked
-- in the API (it lives in the design tokens).
-- Liquid Glass becomes the product's default look (owner decision 12, 2026-11-26): new organizations start with it, and
-- organizations still on the old default ('dashboard', the column default of 015) move to it. People who chose a style keep it.

ALTER TABLE user_prefs DROP CONSTRAINT IF EXISTS user_prefs_style_check;
ALTER TABLE user_prefs ADD CONSTRAINT user_prefs_style_check CHECK (style ~ '^[a-z][a-z-]{1,30}[a-z]$');

ALTER TABLE org_policies DROP CONSTRAINT IF EXISTS org_policies_default_style_check;
ALTER TABLE org_policies ADD CONSTRAINT org_policies_default_style_check CHECK (default_style ~ '^[a-z][a-z-]{1,30}[a-z]$');
ALTER TABLE org_policies ALTER COLUMN default_style SET DEFAULT 'liquid-glass';

UPDATE org_policies SET default_style = 'liquid-glass'
 WHERE default_style = 'dashboard' AND (allowed_styles IS NULL OR 'liquid-glass' = ANY (allowed_styles));
