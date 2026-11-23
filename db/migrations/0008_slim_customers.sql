-- Customers are now stored with only the fields anything reads (see
-- customerForStorage in src/lib/woo/ingest.ts). This trims the rows already
-- stored the same way: the shipping address, username, role, avatar and
-- meta data go, which was about two thirds of each row. The sync also stops
-- rewriting unchanged rows, so the tables stop growing dead copies.
--
-- Space freed here is reused by the table straight away; returning it to the
-- disk needs a one-off `VACUUM FULL woo_customers, woo_orders,
-- woo_order_items;` run by hand (it cannot run inside a migration).

update public.woo_customers
   set raw = jsonb_strip_nulls(jsonb_build_object(
         'id', raw -> 'id',
         'date_created', raw -> 'date_created',
         'email', raw -> 'email',
         'first_name', raw -> 'first_name',
         'last_name', raw -> 'last_name',
         'billing', nullif(jsonb_strip_nulls(jsonb_build_object(
             'first_name', to_jsonb(nullif(raw -> 'billing' ->> 'first_name', '')),
             'last_name', to_jsonb(nullif(raw -> 'billing' ->> 'last_name', '')),
             'company', to_jsonb(nullif(raw -> 'billing' ->> 'company', '')),
             'email', to_jsonb(nullif(raw -> 'billing' ->> 'email', '')),
             'phone', to_jsonb(nullif(raw -> 'billing' ->> 'phone', '')),
             'city', to_jsonb(nullif(raw -> 'billing' ->> 'city', '')),
             'state', to_jsonb(nullif(raw -> 'billing' ->> 'state', '')),
             'country', to_jsonb(nullif(raw -> 'billing' ->> 'country', ''))
         )), '{}'::jsonb)
       ))
 where raw ? 'shipping' or raw ? 'username' or raw ? 'role' or raw ? 'avatar_url' or raw ? 'meta_data';
