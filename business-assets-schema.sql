-- =====================================================================
-- ESTÂNCIA TREZE PIZZARIA — IDENTIDADE VISUAL (logo e favicon)
-- ---------------------------------------------------------------------
-- Prepara SOMENTE a infraestrutura: duas colunas em `businesses`, o
-- bucket `business-assets` e as políticas de Storage. Nenhum arquivo é
-- enviado, nenhuma logo é trocada, e nem o painel nem o site público
-- são alterados nesta etapa.
--
-- Por que um bucket separado:
--     product-images  -> fotos de produtos
--     business-assets -> identidade visual da empresa
-- São ciclos de vida diferentes (a logo troca raramente, as fotos o
-- tempo todo) e políticas diferentes, então ficam separados.
--
-- O caminho dos arquivos é SEMPRE:
--     business-assets/<business_id>/<arquivo>
-- A primeira pasta é o UUID da empresa — nunca o slug, que o dono pode
-- mudar. O banco guarda só esse caminho, nunca a URL pública inteira:
-- assim, se o domínio do projeto mudar, nada precisa ser reescrito.
--
-- Seguro para rodar mais de uma vez: nada é apagado, colunas usam
-- "add column if not exists", o bucket usa "on conflict do nothing" e
-- cada política é criada só se ainda não existir COM AQUELE NOME.
--
-- Nenhum UUID escrito à mão (a empresa vem do slug) e nenhum uso de
-- service_role: os uploads futuros serão feitos pelo navegador do dono,
-- com a Publishable Key + sessão, e quem protege é Auth + RLS.
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
  if to_regprocedure('public.is_business_member(uuid)') is null then
    raise exception 'public.is_business_member(uuid) não existe — rode delivery-schema.sql ou business-hours-schema.sql antes.';
  end if;
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception 'Schema storage não encontrado — este SQL é para um projeto Supabase.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Colunas do caminho dos arquivos
--    Guardam o caminho DENTRO do bucket, não a URL:
--        <business_id>/logo.webp
--        <business_id>/favicon.png
--    Começam NULL: nada de logo ou favicon inventado.
-- ---------------------------------------------------------------------
alter table public.businesses
  add column if not exists logo_path    text,
  add column if not exists favicon_path text;

comment on column public.businesses.logo_path is
  'Caminho do objeto dentro do bucket business-assets (ex.: <business_id>/logo.webp). Nunca a URL pública.';
comment on column public.businesses.favicon_path is
  'Caminho do objeto dentro do bucket business-assets (ex.: <business_id>/favicon.png). Nunca a URL pública.';

-- ---------------------------------------------------------------------
-- 2. Bucket público
--    Público porque logo e favicon aparecem no site sem login. Se o
--    bucket já existir, NÃO é recriado nem reconfigurado; e se ele
--    estiver privado o script ABORTA, para não terminar com uma
--    infraestrutura que nunca exibiria as imagens.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('business-assets', 'business-assets', true)
on conflict (id) do nothing;

do $$
declare
  publico boolean;
begin
  select b.public into publico from storage.buckets b where b.id = 'business-assets';
  if publico is not true then
    /* Aborta a transação inteira: nada fica pela metade e o script não
       termina "com sucesso" deixando um bucket privado, em que logo e
       favicon nunca carregariam no site. Este script não mexe sozinho
       num bucket que já era seu — a decisão é sua. */
    raise exception 'O bucket business-assets já existe e está PRIVADO. '
                    'Logo e favicon não carregariam no site. Torne-o público e rode este script de novo: '
                    'update storage.buckets set public = true where id = ''business-assets'';';
  end if;
  raise notice 'Bucket business-assets pronto e público.';
end $$;

-- ---------------------------------------------------------------------
-- 3. A regra de pasta, numa função só
--    Recebe o `name` do objeto e responde se a PRIMEIRA pasta é o UUID
--    de uma empresa da qual quem chamou é membro.
--
--    O teste do formato UUID vem ANTES do cast justamente para que um
--    nome fora do padrão (ex.: "logo.webp" solto na raiz, ou uma pasta
--    "temp") devolva false em vez de derrubar a operação com erro.
--
--    Arquivo na raiz do bucket: storage.foldername() devolve array
--    vazio, a primeira pasta é NULL e a resposta é false.
-- ---------------------------------------------------------------------
create or replace function public.is_business_folder(p_name text)
returns boolean
language plpgsql
stable
as $$
declare
  primeira text;
begin
  primeira := (storage.foldername(p_name))[1];

  if primeira is null or primeira = '' then
    return false;                                   -- arquivo solto na raiz
  end if;
  if primeira !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;                                   -- pasta que não é UUID
  end if;

  return public.is_business_member(primeira::uuid);  -- é membro DESSA empresa?
end;
$$;

comment on function public.is_business_folder(text) is
  'true quando a primeira pasta do caminho é o UUID de uma empresa da qual auth.uid() é membro. Usada pelas políticas do bucket business-assets.';

revoke all on function public.is_business_folder(text) from public;
grant execute on function public.is_business_folder(text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Políticas de Storage
--    Escrita (insert / update / delete) só para quem está autenticado E
--    só dentro da pasta da PRÓPRIA empresa, no bucket business-assets.
--    O administrador da Empresa A não alcança nada da Empresa B.
--
--    Conferência por NOME: uma política existente com outro propósito
--    não é considerada equivalente só por ser de `authenticated`.
--
--    Se o seu usuário do SQL Editor não puder criar políticas em
--    storage.objects, dá para criar as quatro pelo painel do Supabase
--    (Storage -> Policies) com exatamente as mesmas condições.
-- ---------------------------------------------------------------------
do $$
declare
  cond text := 'bucket_id = ''business-assets'' and public.is_business_folder(name)';
begin
  /* SELECT não é para o público — o público lê pela URL do bucket, sem
     passar por aqui. Esta política existe porque, com RLS ligada e
     NENHUMA política de select, um "update"/"delete" com WHERE não
     enxerga a própria linha e afeta 0 registros: o dono não conseguiria
     substituir nem apagar o próprio arquivo. Mesma condição das demais,
     então a Empresa A continua sem ver nada da Empresa B. */
  if exists (select 1 from pg_policies
             where schemaname = 'storage' and tablename = 'objects'
               and policyname = 'business_assets_select') then
    raise notice 'Política business_assets_select já existia — mantida.';
  else
    execute 'create policy business_assets_select on storage.objects
               for select to authenticated using (' || cond || ')';
    raise notice 'Política business_assets_select criada.';
  end if;

  if exists (select 1 from pg_policies
             where schemaname = 'storage' and tablename = 'objects'
               and policyname = 'business_assets_insert') then
    raise notice 'Política business_assets_insert já existia — mantida.';
  else
    execute 'create policy business_assets_insert on storage.objects
               for insert to authenticated with check (' || cond || ')';
    raise notice 'Política business_assets_insert criada.';
  end if;

  if exists (select 1 from pg_policies
             where schemaname = 'storage' and tablename = 'objects'
               and policyname = 'business_assets_update') then
    raise notice 'Política business_assets_update já existia — mantida.';
  else
    /* using decide QUAIS linhas podem ser alteradas; with check impede
       que a alteração mova o arquivo para a pasta de outra empresa */
    execute 'create policy business_assets_update on storage.objects
               for update to authenticated
               using (' || cond || ') with check (' || cond || ')';
    raise notice 'Política business_assets_update criada.';
  end if;

  if exists (select 1 from pg_policies
             where schemaname = 'storage' and tablename = 'objects'
               and policyname = 'business_assets_delete') then
    raise notice 'Política business_assets_delete já existia — mantida.';
  else
    execute 'create policy business_assets_delete on storage.objects
               for delete to authenticated using (' || cond || ')';
    raise notice 'Política business_assets_delete criada.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Leitura pública
--    NENHUMA política é criada para o público, de propósito. Num bucket
--    público o Supabase serve /storage/v1/object/public/<bucket>/<path>
--    sem autenticação e sem consultar a RLS de storage.objects — é
--    exatamente o que logo e favicon precisam no site, e é como o
--    product-images já funciona hoje.
--
--    A política de select criada acima é outra coisa: vale só para
--    `authenticated`, restrita à pasta da própria empresa, e existe para
--    que o dono consiga substituir e apagar os próprios arquivos.
-- ---------------------------------------------------------------------
do $$
declare
  ligada boolean;
begin
  select c.relrowsecurity into ligada from pg_class c where c.oid = 'storage.objects'::regclass;
  if not ligada then
    /* Sem RLS as políticas acima são decorativas: qualquer pessoa
       autenticada poderia escrever na pasta de qualquer empresa. Melhor
       abortar do que terminar dando a impressão de que está protegido. */
    raise exception 'RLS está DESLIGADA em storage.objects — as políticas ficariam inertes e as pastas '
                    'das empresas não estariam protegidas. No Supabase ela vem ligada por padrão; '
                    'para religar, rode: alter table storage.objects enable row level security;';
  end if;
end $$;

commit;

-- =====================================================================
-- 6. CONFERÊNCIA
-- =====================================================================

-- 6.1 Colunas novas (esperado: logo_path e favicon_path, text, nullable)
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'businesses'
  and column_name in ('logo_path', 'favicon_path')
order by column_name;

-- 6.2 A empresa (esperado: logo_path e favicon_path vazios)
select b.slug, b.name, b.logo_path, b.favicon_path
from public.businesses b
where b.slug = 'estancia-treze';

-- 6.3 O bucket (esperado: business-assets, public = true)
select id, name, public
from storage.buckets
where id = 'business-assets';

-- 6.4 Políticas do bucket em storage.objects
--     Esperado: QUATRO, todas para authenticated e citando business-assets —
--       business_assets_select   (SELECT)
--       business_assets_insert   (INSERT)
--       business_assets_update   (UPDATE)
--       business_assets_delete   (DELETE)
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and (coalesce(qual, '') like '%business-assets%'
    or coalesce(with_check, '') like '%business-assets%')
order by cmd, policyname;
