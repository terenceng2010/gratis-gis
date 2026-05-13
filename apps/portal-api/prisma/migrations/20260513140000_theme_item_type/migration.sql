-- #22 theme item type. Stores an AppThemeTokens bundle (surface
-- ladder, header tokens, accent, radii, shadows, density).  Five
-- starters (default/slate/aurora/forest/paper) seed per-org via
-- auth-sync, alongside any themes an author saves themselves.
-- CustomAppData.themePresetId references one of these item ids.

ALTER TYPE "ItemType" ADD VALUE 'theme';
