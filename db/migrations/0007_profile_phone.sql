-- Sign-up asks for a name and a mobile number as well as email and password.
-- The name already had a column (full_name); the number is new. Stored in
-- E.164 form (+919876543210). Used to prefill Razorpay checkout (card
-- mandates need it for OTPs) and shown to admins for support.
alter table public.profiles add column if not exists phone text;
