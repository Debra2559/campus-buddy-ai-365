-- 创建测试超级管理员账号（完整流程）
DO $$
DECLARE
  new_user_id uuid;
  new_identity_id uuid := gen_random_uuid();
BEGIN
  -- 步骤1: 插入 auth.users
  INSERT INTO auth.users (
    id, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, role,
    confirmation_sent_at, email_change, email_change_confirm_status,
    banned_until, reauthentication_sent_at, is_sso_user, deleted_at
  )
  VALUES (
    gen_random_uuid(), 'tenghuijin@163.com', crypt('tenghuijin@163.com', gen_salt('bf')),
    now(), '{"provider":"email","providers":["email"]}', '{"display_name":"腾辉锦"}',
    now(), now(), 'authenticated', now(), '', 0, null, null, false, null
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO new_user_id;
  
  -- 如果插入冲突（已存在），查询现有用户ID
  IF new_user_id IS NULL THEN
    SELECT id INTO new_user_id FROM auth.users WHERE email = 'tenghuijin@163.com';
  END IF;
  
  -- 步骤2: 插入 auth.identities
  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    created_at, updated_at, last_sign_in_at
  )
  VALUES (
    new_identity_id, new_user_id,
    '{"sub":"tenghuijin@163.com","email":"tenghuijin@163.com","email_verified":true,"phone_verified":false}',
    'email', new_identity_id::text,
    now(), now(), now()
  )
  ON CONFLICT DO NOTHING;
  
  -- 步骤3: 赋予 super_admin 角色
  INSERT INTO public.user_roles (user_id, role)
  VALUES (new_user_id, 'super_admin')
  ON CONFLICT DO NOTHING;
END $$;