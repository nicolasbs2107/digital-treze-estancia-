-- =====================================================================
-- ESTÂNCIA TREZE PIZZARIA — PERFIL PÚBLICO DA EMPRESA
-- ---------------------------------------------------------------------
-- Amplia a tabela `businesses` com descrição curta, Instagram e endereço
-- estruturado. NENHUMA tabela nova: esses dados são atributos da empresa
-- e pertencem à linha dela.
--
-- Seguro para rodar mais de uma vez: só "add column if not exists",
-- verificações antes de criar função/gatilho/política e nenhum comando
-- destrutivo. Não toca em name, slug, whatsapp, produtos, categorias,
-- horários nem delivery.
--
-- Nenhum UUID escrito à mão (a empresa vem do slug) e nenhum uso de
-- service_role.
--
-- Todos os campos entram como NULL: nada de descrição, Instagram ou
-- endereço inventado. Quem preenche é o proprietário, pelo painel.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Conferências antes de mexer em qualquer coisa
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.businesses') is null then
    raise exception 'Tabela public.businesses não encontrada.';
  end if;

  if not exists (select 1 from public.businesses where slug = 'estancia-treze') then
    raise exception 'Empresa com slug "estancia-treze" não encontrada em public.businesses';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Novas colunas do perfil público
--    Tudo TEXT: CEP e número de endereço podem ter zero à esquerda,
--    letras ("s/n", "123-A") ou formatos regionais — número nunca.
-- ---------------------------------------------------------------------
alter table public.businesses
  add column if not exists short_description    text,
  add column if not exists instagram            text,
  add column if not exists address_street       text,
  add column if not exists address_number       text,
  add column if not exists address_neighborhood text,
  add column if not exists address_complement   text,
  add column if not exists address_city         text,
  add column if not exists address_state        text,
  add column if not exists address_postal_code  text;

comment on column public.businesses.short_description is
  'Frase curta usada em partes públicas do site (seção Sobre). Texto puro, sem HTML.';
comment on column public.businesses.instagram is
  'Somente o identificador da conta, sem @ e sem URL (ex.: estanciatreze). O site monta https://instagram.com/<identificador>.';
comment on column public.businesses.address_number is
  'Texto de propósito: aceita "s/n", "123-A" e zeros à esquerda.';
comment on column public.businesses.address_state is
  'Sigla da UF (ex.: SP). A normalização é feita no painel.';
comment on column public.businesses.address_postal_code is
  'CEP como texto, para preservar zeros à esquerda (ex.: 01234-567).';

-- ---------------------------------------------------------------------
-- 2. updated_at
--    Só cria o que faltar: a coluna, a função de apoio e o gatilho.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'businesses' and column_name = 'updated_at'
  ) then
    execute 'alter table public.businesses
               add column updated_at timestamptz not null default now()';
    raise notice 'Coluna businesses.updated_at criada.';
  else
    raise notice 'Coluna businesses.updated_at já existia — mantida como está.';
  end if;
end $$;

-- Função de apoio: já veio no business-hours-schema.sql. Só cria se faltar.
do $$
begin
  if to_regprocedure('public.tg_set_updated_at()') is null then
    execute $f$
      create function public.tg_set_updated_at()
      returns trigger
      language plpgsql
      as $inner$
      begin
        new.updated_at = now();
        return new;
      end;
      $inner$;
    $f$;
    raise notice 'Função public.tg_set_updated_at criada.';
  else
    raise notice 'Função public.tg_set_updated_at já existia — reaproveitada.';
  end if;
end $$;

-- Gatilho: procura por FUNÇÃO, não por nome, para não duplicar um
-- gatilho equivalente que já exista com outro nome.
do $$
declare
  existente text;
begin
  select string_agg(t.tgname, ', ')
    into existente
  from pg_trigger t
  where t.tgrelid = 'public.businesses'::regclass
    and not t.tgisinternal
    and t.tgfoid = to_regprocedure('public.tg_set_updated_at()')::oid;

  if existente is not null then
    raise notice 'Gatilho de updated_at já existia em businesses (%) — mantido.', existente;
  else
    execute 'create trigger set_updated_at
               before update on public.businesses
               for each row execute function public.tg_set_updated_at()';
    raise notice 'Gatilho set_updated_at criado em businesses.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. RLS
--    IMPORTANTE: no Postgres, política de RLS é por LINHA, não por
--    coluna. As políticas que já existem em businesses passam a valer
--    para as colunas novas automaticamente — não há nada a duplicar.
--    Os blocos abaixo apenas CONFEREM e só criam o que estiver faltando:
--        público              -> SELECT
--        membro da empresa    -> UPDATE
-- ---------------------------------------------------------------------
do $$
declare
  rls_ligada boolean;
begin
  select relrowsecurity into rls_ligada from pg_class where oid = 'public.businesses'::regclass;
  if not rls_ligada then
    raise notice 'ATENÇÃO: RLS está DESLIGADA em public.businesses. As políticas abaixo '
                 'ficam inertes até você rodar: alter table public.businesses enable row level security; '
                 'Este script não liga sozinho para não bloquear leituras em produção sem o seu aval.';
  end if;
end $$;

-- 3.1 leitura pública
do $$
declare
  ja text;
begin
  select string_agg(policyname, ', ')
    into ja
  from pg_policies
  where schemaname = 'public'
    and tablename = 'businesses'
    and permissive = 'PERMISSIVE'
    and cmd in ('SELECT', 'ALL')
    and (roles && array['anon', 'public']::name[]);

  if ja is not null then
    raise notice 'Leitura pública já coberta por: % — nenhuma política criada.', ja;
  else
    execute 'create policy businesses_leitura_publica
               on public.businesses for select to anon, authenticated using (true)';
    raise notice 'Política businesses_leitura_publica criada.';
  end if;
end $$;

-- 3.2 escrita restrita ao administrador da empresa
do $$
declare
  ja text;
begin
  select string_agg(policyname, ', ')
    into ja
  from pg_policies
  where schemaname = 'public'
    and tablename = 'businesses'
    and permissive = 'PERMISSIVE'
    and cmd in ('UPDATE', 'ALL')
    and (roles && array['authenticated', 'public']::name[]);

  if ja is not null then
    raise notice 'Atualização já coberta por: % — nenhuma política criada.', ja;
  else
    if to_regprocedure('public.is_business_member(uuid)') is null then
      raise exception 'public.is_business_member(uuid) não existe — rode o delivery-schema.sql ou o business-hours-schema.sql antes.';
    end if;
    execute 'create policy businesses_gestao
               on public.businesses for update to authenticated
               using      (public.is_business_member(id))
               with check (public.is_business_member(id))';
    raise notice 'Política businesses_gestao criada.';
  end if;
end $$;

-- Permissões de tabela (independentes de RLS). "grant" é idempotente.
grant select on public.businesses to anon, authenticated;
grant update on public.businesses to authenticated;

commit;

-- =====================================================================
-- 4. CONFERÊNCIA
-- =====================================================================

-- 4.1 Colunas atuais de businesses
--     (esperado: as 9 novas + updated_at, todas text/timestamptz)
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'businesses'
order by ordinal_position;

-- 4.2 Dados da empresa — os campos novos devem estar todos NULL
select b.slug, b.name, b.whatsapp,
       b.short_description, b.instagram,
       b.address_street, b.address_number, b.address_neighborhood,
       b.address_complement, b.address_city, b.address_state, b.address_postal_code,
       b.created_at, b.updated_at
from public.businesses b
where b.slug = 'estancia-treze';

-- 4.3 Políticas da tabela (esperado: uma de SELECT e uma de UPDATE)
select policyname, permissive, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'businesses'
order by cmd, policyname;

-- 4.4 RLS ligada? (esperado: true)
select relname as tabela, relrowsecurity as rls_ligada, relforcerowsecurity as rls_forcada
from pg_class
where oid = 'public.businesses'::regclass;
