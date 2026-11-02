-- Optional starter configuration for a new club. Review the rates before use —
-- everything here can be changed later in Settings. Safe to run once.
insert into public.floors (name, sort_order) values ('Ground Floor', 1), ('First Floor', 2)
on conflict do nothing;

-- Rates are rupees per minute.
insert into public.table_categories (name, rate_per_minute, sort_order) values
  ('Snooker', 10, 1),
  ('Pool', 7, 2),
  ('Table Tennis', 5, 3)
on conflict do nothing;
