/* ============================================================
   Velora Fresh — deployment configuration
   Inlined into index.html by src/build.py.

   Leave anonKey empty and the app runs exactly as it always has:
   localStorage only, no network, role chosen from the dropdown.
   Fill it in and the app requires a real login and syncs.
   ============================================================ */

window.VF_CONFIG = {

  /* Supabase project URL — Settings -> API -> Project URL.
     No trailing slash, and no /rest/v1 on the end. */
  url: 'https://ahcivdltoqiciphwkrxf.supabase.co',

  /* Settings -> API -> Project API keys -> "anon" "public".
     Paste it between the quotes below.

     This key is meant to be public: it ships inside the page and
     identifies the project, nothing more. What actually protects the
     data is the row level security in supabase/02_security.sql — a
     shop holding this key still cannot read another shop's bills.

     The service_role key is the opposite. It bypasses every policy.
     Never put it here, and never commit it anywhere. */
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFoY2l2ZGx0b3FpY2lwaHdrcnhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1MDIzMjMsImV4cCI6MjEwMTA3ODMyM30.H8QVR0HYFr2W71bLuMFkPRzP1GsbDWmivjbkBgTjjJc',

  /* The client this deployment serves. Matches clients.id. */
  clientId: 'KPN',
};
