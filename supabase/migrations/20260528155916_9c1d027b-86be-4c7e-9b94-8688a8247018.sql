
DO $$
BEGIN
  RAISE NOTICE 'Identities columns: %', (
    SELECT string_agg(column_name, ', ') 
    FROM information_schema.columns 
    WHERE table_schema = 'auth' AND table_name = 'identities'
  );
END $$;
