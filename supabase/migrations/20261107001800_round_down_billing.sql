-- =============================================================================
-- FUSION 1800: bill completed minutes only ("round down").
--
-- Impact on existing data: one setting changes — settings.billing_rounding
-- becomes 'down' (and so does its default). No invoice, session or total is
-- rewritten: sessions already ended keep the charge they were ended with.
--
-- The billing policy (Settings → Billing rules) already offers rounding up,
-- to the nearest or down; until now the club billed every started minute
-- ("up": 60 min 05 s = 61 minutes). From now on a minute is charged only once
-- all 60 seconds of it have been played, everywhere the policy applies —
-- open play, a booking ended early, and time after "Continue" on a booking
-- (60 min 05 s of a 1-hour, PKR 600 booking stays PKR 600 until 61 full
-- minutes = PKR 610). The live timer and checkout read the same setting, so
-- they show exactly what the database charges. It can still be changed in
-- Settings → Billing rules.
-- =============================================================================

alter table public.settings alter column billing_rounding set default 'down';
update public.settings set billing_rounding = 'down' where billing_rounding <> 'down';
