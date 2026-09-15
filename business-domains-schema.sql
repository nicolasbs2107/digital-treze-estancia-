-- =====================================================================
-- MULTITENANT — DOMÍNIOS POR EMPRESA
-- ---------------------------------------------------------------------
-- Prepara SOMENTE o banco. Nenhum arquivo do site público ou do painel é
-- alterado nesta etapa, e NENHUM domínio é cadastrado: a tabela começa
-- vazia, de propósito, porque o domínio definitivo ainda não existe.
--
-- A ideia:
--     estanciatreze.com.br   -> Estância Treze
--     pizzariadojoao.com.br  -> Pizzaria do João
-- mesmo código, mesmo Supabase, mesmas tabelas — o hostname acessado é
-- que diz de qual empresa é o cardápio.
--
-- Duas peças novas:
--     public.business_domains            (tabela, com RLS fechada)
--     public.resolve_business_by_domain  (RPC pública, só leitura)
--
-- O visitante NUNCA lê business_domains diretamente: ele pergunta à RPC
-- "este hostname é de qual empresa?" e recebe apenas business_id e slug.
--
-- Seguro para rodar mais de uma vez: "if not exists" em tabela e índices,
-- constraints e políticas criadas só quando faltam, funções com
-- "create or replace". Nenhum drop de tabela ou coluna, nenhum registro
-- apagado.
--
-- Sem service_role, sem secret key e sem UUID escrito à mão.
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
  if to_regprocedure('public.is_business_member(uuid)') is null then
    raise exception 'public.is_business_member(uuid) não existe — rode delivery-schema.sql ou business-hours-schema.sql antes.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Normalização do domínio
--    Recebe qualquer coisa que um humano digite e devolve só o hostname:
--
--      HTTPS://WWW.Exemplo.COM.br/cardapio?x=1#topo  ->  exemplo.com.br
--      www.exemplo.com.br:443                        ->  exemplo.com.br
--      pedido.exemplo.com.br                         ->  pedido.exemplo.com.br
--
--    O que sai: protocolo, usuário:senha@, caminho, query, fragmento,
--    porta, espaços, ponto final do hostname e o prefixo EXATO "www.".
--    Subdomínio legítimo NÃO é tocado — só "www." vai embora.
--
--    Devolve NULL quando não sobra hostname nenhum; quem recusa o vazio
--    é o gatilho da seção 4 (com mensagem clara) e o CHECK da tabela.
--    IMMUTABLE: para a mesma entrada, sempre a mesma saída — por isso
--    pode ser usada em índice e em constraint.
-- ---------------------------------------------------------------------
create or replace function public.normalize_business_domain(p_valor text)
returns text
language plpgsql
immutable
as $$
declare
  d text;
begin
  if p_valor is null then
    return null;
  end if;

  d := lower(btrim(p_valor));
  d := regexp_replace(d, '\s', '', 'g');            -- qualquer espaço, em qualquer lugar
  if d = '' then
    return null;
  end if;

  d := regexp_replace(d, '^[a-z][a-z0-9+.-]*://', '');   -- http:// https:// etc.
  d := split_part(d, '/', 1);                            -- caminho
  d := split_part(d, '?', 1);                            -- query
  d := split_part(d, '#', 1);                            -- fragmento
  d := regexp_replace(d, '^[^@]*@', '');                 -- usuario:senha@
  d := regexp_replace(d, ':[0-9]+$', '');                -- porta
  d := regexp_replace(d, '\.+$', '');                    -- ponto final do hostname
  d := regexp_replace(d, '^www\.', '');                  -- SÓ o prefixo exato www.
  d := regexp_replace(d, '\.+$', '');                    -- ponto final de novo, por garantia

  if d = '' then
    return null;
  end if;
  return d;
end;
$$;

comment on function public.normalize_business_domain(text) is
  'Reduz uma URL ou hostname ao hostname normalizado em minúsculas, sem protocolo, caminho, query, porta nem prefixo www. Devolve NULL quando não sobra hostname.';

revoke all on function public.normalize_business_domain(text) from public;
grant execute on function public.normalize_business_domain(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. A tabela
--    Uma empresa pode ter vários domínios (o próprio e o da Vercel, por
--    exemplo); cada domínio pertence a uma empresa só.
-- ---------------------------------------------------------------------
create table if not exists public.business_domains (
  id          uuid        primary key default gen_random_uuid(),
  business_id uuid        not null references public.businesses (id) on delete cascade,
  domain      text        not null,
  is_primary  boolean     not null default false,
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.business_domains is
  'Hostnames que apontam para cada empresa. O site público descobre a empresa pelo domínio acessado, via resolve_business_by_domain().';
comment on column public.business_domains.domain is
  'Hostname já normalizado (minúsculas, sem www., sem protocolo, porta ou caminho). O gatilho normaliza automaticamente.';
comment on column public.business_domains.is_primary is
  'O domínio canônico da empresa. No máximo um por empresa, e obrigatoriamente ativo.';

-- Formato mínimo de hostname: rótulos alfanuméricos separados por ponto.
-- Aceita hostname sem ponto (localhost) para o ambiente de desenvolvimento.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.business_domains'::regclass
                   and conname = 'business_domains_formato_check') then
    execute $c$
      alter table public.business_domains
        add constraint business_domains_formato_check
        check (
          domain = lower(domain)
          and length(domain) between 1 and 253
          and domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'
        )
    $c$;
    raise notice 'Constraint business_domains_formato_check criada.';
  else
    raise notice 'Constraint business_domains_formato_check já existia — mantida.';
  end if;
end $$;

-- Domínio principal precisa estar ativo.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.business_domains'::regclass
                   and conname = 'business_domains_primario_ativo_check') then
    execute $c$
      alter table public.business_domains
        add constraint business_domains_primario_ativo_check
        check (is_primary is false or active is true)
    $c$;
    raise notice 'Constraint business_domains_primario_ativo_check criada.';
  else
    raise notice 'Constraint business_domains_primario_ativo_check já existia — mantida.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Índices
--    · domínio é único no projeto INTEIRO (inclusive se estiver inativo):
--      duas empresas nunca disputam o mesmo hostname;
--    · no máximo um is_primary por empresa (índice único PARCIAL).
-- ---------------------------------------------------------------------
create unique index if not exists business_domains_domain_uk
  on public.business_domains (domain);

create unique index if not exists business_domains_um_primario_uk
  on public.business_domains (business_id)
  where is_primary;

create index if not exists business_domains_empresa_idx
  on public.business_domains (business_id);

-- ---------------------------------------------------------------------
-- 4. Normalização automática
--    O banco não depende do frontend para ficar consistente: mesmo que
--    alguém mande "https://WWW.Exemplo.com/", o que é gravado é
--    "exemplo.com".
-- ---------------------------------------------------------------------
create or replace function public.tg_normalizar_dominio()
returns trigger
language plpgsql
as $$
declare
  limpo text;
begin
  limpo := public.normalize_business_domain(new.domain);
  if limpo is null then
    raise exception 'Domínio inválido: %. Informe um endereço como empresa.com.br.', new.domain;
  end if;
  new.domain := limpo;
  return new;
end;
$$;

drop trigger if exists normalizar_dominio on public.business_domains;
create trigger normalizar_dominio
  before insert or update of domain on public.business_domains
  for each row execute function public.tg_normalizar_dominio();

-- ---------------------------------------------------------------------
-- 5. updated_at — reaproveita a função que o projeto já tem
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.tg_set_updated_at()') is null then
    execute $f$
      create function public.tg_set_updated_at()
      returns trigger language plpgsql as $inner$
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

drop trigger if exists set_updated_at on public.business_domains;
create trigger set_updated_at
  before update on public.business_domains
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- 6. RLS — tabela FECHADA
--    Diferente das outras tabelas do projeto, aqui NÃO existe leitura
--    pública: a lista de domínios de todos os clientes não é assunto de
--    visitante. Quem lê e escreve é o administrador, e só da própria
--    empresa. Quem responde ao visitante é a RPC da seção 7.
-- ---------------------------------------------------------------------
alter table public.business_domains enable row level security;

revoke all on public.business_domains from anon;
grant select, insert, update, delete on public.business_domains to authenticated;

do $$
declare
  cond text := 'public.is_business_member(business_id)';
  nomes text[] := array['business_domains_select', 'business_domains_insert',
                        'business_domains_update', 'business_domains_delete'];
  n text;
begin
  foreach n in array nomes loop
    if exists (select 1 from pg_policies
               where schemaname = 'public' and tablename = 'business_domains'
                 and policyname = n) then
      raise notice 'Política % já existia — mantida.', n;
      continue;
    end if;

    if n = 'business_domains_select' then
      execute 'create policy ' || n || ' on public.business_domains
                 for select to authenticated using (' || cond || ')';
    elsif n = 'business_domains_insert' then
      execute 'create policy ' || n || ' on public.business_domains
                 for insert to authenticated with check (' || cond || ')';
    elsif n = 'business_domains_update' then
      /* using: quais linhas ele alcança. with check: impede transferir o
         domínio para outra empresa no meio do caminho. */
      execute 'create policy ' || n || ' on public.business_domains
                 for update to authenticated
                 using (' || cond || ') with check (' || cond || ')';
    else
      execute 'create policy ' || n || ' on public.business_domains
                 for delete to authenticated using (' || cond || ')';
    end if;
    raise notice 'Política % criada.', n;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. RPC pública de resolução
--    A única porta de entrada do visitante. Responde exatamente uma
--    pergunta — "este hostname é de qual empresa?" — e devolve só
--    business_id e slug. Nada de listar domínios, nada de dados
--    administrativos, nada de escrita.
--
--    SECURITY DEFINER: roda com os privilégios do dono da função, que
--    enxerga business_domains. É isso que permite manter a tabela
--    fechada para anon sem precisar de nenhuma política de leitura
--    pública. search_path fixo em public, pg_temp (pg_temp por último)
--    para que nenhum objeto temporário criado por quem chama possa se
--    passar pelos objetos reais.
--
--    É uma função SQL com um único SELECT: não existe caminho para
--    insert, update ou delete dentro dela.
-- ---------------------------------------------------------------------
create or replace function public.resolve_business_by_domain(p_hostname text)
returns table (business_id uuid, slug text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.business_id, b.slug
  from public.business_domains d
  join public.businesses b on b.id = d.business_id
  where d.active is true
    and d.domain = public.normalize_business_domain(p_hostname)
  limit 1;
$$;

comment on function public.resolve_business_by_domain(text) is
  'Descobre a empresa a partir do hostname acessado. Só leitura, só domínios ativos, devolve apenas business_id e slug. Zero linhas quando o domínio não está cadastrado.';

revoke all on function public.resolve_business_by_domain(text) from public;
grant execute on function public.resolve_business_by_domain(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. Nenhum domínio é cadastrado aqui
--    A tabela começa vazia de propósito. Quando o endereço definitivo
--    existir, o cadastro será feito pelo painel (ou por um insert seu),
--    sempre buscando a empresa pelo slug — nunca com UUID escrito à mão:
--
--    insert into public.business_domains (business_id, domain, is_primary)
--    select b.id, 'oendereco-real.com.br', true
--    from public.businesses b
--    where b.slug = 'estancia-treze';
-- ---------------------------------------------------------------------

commit;

-- =====================================================================
-- 9. CONFERÊNCIA
-- =====================================================================

-- 9.A Estrutura da tabela
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'business_domains'
order by ordinal_position;

-- 9.B RLS ligada? (esperado: true)
select relname as tabela, relrowsecurity as rls_ligada, relforcerowsecurity as rls_forcada
from pg_class
where oid = 'public.business_domains'::regclass;

-- 9.C Políticas
--     Esperado: QUATRO, todas para authenticated e com is_business_member —
--       business_domains_select (SELECT), business_domains_insert (INSERT),
--       business_domains_update (UPDATE), business_domains_delete (DELETE).
--     Nenhuma para anon: visitante não lê esta tabela.
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'business_domains'
order by cmd, policyname;

-- 9.D Índices e constraints
--     Esperado: domínio único global, um is_primary por empresa,
--     formato de hostname e "principal precisa estar ativo".
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'business_domains'
order by indexname;

select conname, pg_get_constraintdef(oid) as definicao
from pg_constraint
where conrelid = 'public.business_domains'::regclass
order by conname;

-- 9.E As duas funções
--     Esperado: normalize_business_domain -> text, immutable, definer = false
--               resolve_business_by_domain -> record, stable, definer = true
select p.proname as funcao,
       pg_get_function_result(p.oid) as retorno,
       case p.provolatile when 'i' then 'immutable'
                          when 's' then 'stable'
                          else 'volatile' end as volatilidade,
       p.prosecdef as security_definer,
       pg_get_function_identity_arguments(p.oid) as argumentos
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('normalize_business_domain', 'resolve_business_by_domain')
order by p.proname;

-- Quem pode executar a RPC (esperado: anon e authenticated, além do dono)
select grantee, privilege_type
from information_schema.routine_privileges
where specific_schema = 'public'
  and routine_name = 'resolve_business_by_domain'
order by grantee;

-- 9.F Normalização — não grava nada, só mostra o resultado
select entrada, public.normalize_business_domain(entrada) as normalizado, esperado,
       (public.normalize_business_domain(entrada) is not distinct from esperado) as ok
from (values
  ('HTTPS://WWW.Exemplo.COM.br/',              'exemplo.com.br'),
  ('https://www.exemplo.com.br/cardapio?x=1',  'exemplo.com.br'),
  ('pedido.exemplo.com.br',                    'pedido.exemplo.com.br'),
  ('www.exemplo.com.br:443',                   'exemplo.com.br'),
  ('exemplo.com.br/',                          'exemplo.com.br'),
  ('  EXEMPLO.com.br.  ',                      'exemplo.com.br'),
  ('http://user:senha@www.exemplo.com.br:8080/x#topo', 'exemplo.com.br'),
  ('localhost:3000',                           'localhost'),
  ('empresa-a.vercel.app',                     'empresa-a.vercel.app'),
  ('',                                         null),
  ('https://',                                 null)
) as t(entrada, esperado);

-- =====================================================================
-- 10. TESTE DA RPC
--     Com a tabela vazia, o esperado é ZERO LINHAS — e nenhum erro.
-- =====================================================================
select * from public.resolve_business_by_domain('exemplo.com.br');

-- Hostname sem sentido também devolve zero linhas, sem erro
select * from public.resolve_business_by_domain('https://');

-- Quantos domínios existem hoje (esperado: 0)
select count(*) as dominios_cadastrados from public.business_domains;
