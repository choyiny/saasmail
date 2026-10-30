-- Public subscribe forms are removed. This runs before 0091 drops their
-- columns and tables, while `confirmed_at` and the `form` source still exist.
--
-- Keep the double opt-in confirmation as the consent time, unless a later
-- consent is already stored (a member who left and rejoined by a single
-- opt-in form keeps the newer one).
UPDATE list_members SET consent_at = confirmed_at WHERE confirmed_at IS NOT NULL AND (consent_at IS NULL OR consent_at < confirmed_at);
--> statement-breakpoint
-- Pending members never confirmed: no consent, no membership.
DELETE FROM list_members WHERE status = 'pending';
--> statement-breakpoint
-- `form` leaves the source enums: members who joined through a form now show
-- `api`, the source for members added by an authenticated caller.
UPDATE list_members SET source = 'api' WHERE source = 'form';
--> statement-breakpoint
UPDATE list_members SET consent_source = 'api' WHERE consent_source = 'form';
