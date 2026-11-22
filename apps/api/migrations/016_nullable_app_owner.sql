-- Make apps.owner_id nullable so a user record can be deleted without hard-deleting apps.
-- User account deletion NULLs this column before removing the user row.
ALTER TABLE apps ALTER COLUMN owner_id DROP NOT NULL;
