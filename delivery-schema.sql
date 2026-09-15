-- =====================================================================
-- ESTÂNCIA TREZE PIZZARIA — ENTREGA (DELIVERY)
-- ---------------------------------------------------------------------
-- Cria as tabelas de configuração de entrega, as políticas de RLS e a
-- configuração inicial da Estância Treze.
--
-- Seguro para rodar mais de uma vez: tudo é "if not exists" / "drop policy
-- if exists", e o seed usa "on conflict do nothing" — rodar de novo NÃO
-- sobrescreve o que já tiver sido ajustado no painel.
--
-- Nenhum UUID escrito à mão: a empresa vem do slug 'estancia-treze'.
-- Nenhum uso de service_role.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Conferências. Se algo faltar, o script para aqui e nada é criado.
-- ---------------------------------------------------------------------
do $$
declare
  v_faltando text;
begin
  if not exists (select 1 from public.businesses where slug = 'estancia-treze') then
    raise exception 'Empresa com slug "estancia-treze" não encontrada em public.businesses';
  end if;

  if to_regclass('public.business_members') is null then
    raise exception 'Tabela public.business_members não encontrada — ela é a base das políticas de RLS';
  end if;

  -- as políticas abaixo assumem estas duas colunas em business_members
  select string_agg(c, ', ') into v_faltando
  from unnest(array['user_id','business_id']) as c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'business_members' and column_name = c
  );

  if v_faltando is not null then
    raise exception 'business_members não tem a(s) coluna(s): %. Ajuste o nome dentro da função public.is_business_member antes de rodar.', v_faltando;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Função auxiliar: o usuário logado administra esta empresa?
--    SECURITY DEFINER para poder ler business_members sem depender da
--    RLS daquela tabela (e sem risco de recursão entre políticas).
-- ---------------------------------------------------------------------
create or replace function public.is_business_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.business_members m
    where m.business_id = p_business_id
      and m.user_id = auth.uid()
  );
$$;

revoke all on function public.is_business_member(uuid) from public;
grant execute on function public.is_business_member(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Função de apoio para manter updated_at em dia
-- ---------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. delivery_settings — uma configuração por empresa
-- ---------------------------------------------------------------------
create table if not exists public.delivery_settings (
  business_id                  uuid primary key
                                 references public.businesses (id) on delete cascade,
  enabled                      boolean        not null default true,
  fee_mode                     text           not null default 'confirm',
  fixed_fee                    numeric(10,2),
  min_order                    numeric(10,2)  not null default 0,
  free_delivery_above          numeric(10,2),
  allow_unlisted_neighborhoods boolean        not null default true,
  created_at                   timestamptz    not null default now(),
  updated_at                   timestamptz    not null default now(),

  -- só os três modos previstos
  constraint delivery_settings_fee_mode_check
    check (fee_mode in ('confirm', 'fixed', 'by_neighborhood')),

  -- taxa fixa exige valor; nos outros modos o campo fica nulo
  constraint delivery_settings_fixed_fee_check
    check (
      (fee_mode = 'fixed' and fixed_fee is not null and fixed_fee >= 0)
      or (fee_mode <> 'fixed')
    ),

  constraint delivery_settings_valores_check
    check (
      min_order >= 0
      and (free_delivery_above is null or free_delivery_above >= 0)
    )
);

comment on table  public.delivery_settings is 'Regras de entrega por empresa. Lida pelo checkout público e editada pelo painel.';
comment on column public.delivery_settings.fee_mode is 'confirm = taxa a confirmar pela pizzaria | fixed = taxa única | by_neighborhood = taxa por bairro (delivery_zones)';
comment on column public.delivery_settings.min_order is 'Valor mínimo do pedido para entrega. 0 = sem mínimo.';
comment on column public.delivery_settings.free_delivery_above is 'Acima deste valor a entrega sai grátis. NULL = sem regra.';
comment on column public.delivery_settings.allow_unlisted_neighborhoods is 'true = aceita pedido de bairro fora da lista (taxa a confirmar).';

drop trigger if exists set_updated_at on public.delivery_settings;
create trigger set_updated_at
  before update on public.delivery_settings
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- 4. delivery_zones — bairros/regiões atendidos (começa VAZIA)
-- ---------------------------------------------------------------------
create table if not exists public.delivery_zones (
  id          uuid          primary key default gen_random_uuid(),
  business_id uuid          not null references public.businesses (id) on delete cascade,
  name        text          not null,
  fee         numeric(10,2) not null default 0,
  active      boolean       not null default true,
  position    integer       not null default 0,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),

  constraint delivery_zones_name_check check (length(btrim(name)) > 0),
  constraint delivery_zones_fee_check  check (fee >= 0)
);

comment on table public.delivery_zones is 'Bairros atendidos e a taxa de cada um. Usada quando delivery_settings.fee_mode = by_neighborhood.';

-- Um bairro não pode aparecer duas vezes na mesma empresa com taxas
-- diferentes. Comparação sem diferenciar maiúsculas/minúsculas.
-- (Se preferir permitir nomes repetidos, apague este índice.)
create unique index if not exists delivery_zones_empresa_nome_uk
  on public.delivery_zones (business_id, lower(btrim(name)));

create index if not exists delivery_zones_empresa_idx
  on public.delivery_zones (business_id, position);

drop trigger if exists set_updated_at on public.delivery_zones;
create trigger set_updated_at
  before update on public.delivery_zones
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- 5. RLS
--    Leitura liberada para o público (o checkout precisa das regras).
--    Escrita só para quem administra AQUELA empresa.
-- ---------------------------------------------------------------------
alter table public.delivery_settings enable row level security;
alter table public.delivery_zones    enable row level security;

-- privilégios de tabela (a RLS decide as linhas; isto decide os verbos)
grant select on public.delivery_settings, public.delivery_zones to anon, authenticated;
grant insert, update, delete on public.delivery_settings, public.delivery_zones to authenticated;

-- ----- delivery_settings -----
drop policy if exists delivery_settings_leitura_publica on public.delivery_settings;
create policy delivery_settings_leitura_publica
  on public.delivery_settings
  for select
  to anon, authenticated
  using (true);

drop policy if exists delivery_settings_gestao on public.delivery_settings;
create policy delivery_settings_gestao
  on public.delivery_settings
  for all
  to authenticated
  using      (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

-- ----- delivery_zones -----
-- público enxerga apenas bairros ativos
drop policy if exists delivery_zones_leitura_publica on public.delivery_zones;
create policy delivery_zones_leitura_publica
  on public.delivery_zones
  for select
  to anon, authenticated
  using (active);

-- membro da empresa enxerga e altera tudo da própria empresa
-- (para SELECT as políticas se somam: o membro vê ativos e inativos)
drop policy if exists delivery_zones_gestao on public.delivery_zones;
create policy delivery_zones_gestao
  on public.delivery_zones
  for all
  to authenticated
  using      (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

-- ---------------------------------------------------------------------
-- 6. Configuração inicial da Estância Treze
--    Sem bairros: delivery_zones começa vazia, como combinado.
--    "do nothing" protege ajustes já feitos no painel.
-- ---------------------------------------------------------------------
insert into public.delivery_settings
  (business_id, enabled, fee_mode, fixed_fee, min_order, free_delivery_above, allow_unlisted_neighborhoods)
select b.id, true, 'confirm', null, 0, null, true
from public.businesses b
where b.slug = 'estancia-treze'
on conflict (business_id) do nothing;

commit;

-- =====================================================================
-- 7. CONFERÊNCIA
-- =====================================================================

-- 7.1 Configuração da empresa (esperado: 1 linha, fee_mode = confirm)
select b.slug,
       d.enabled,
       d.fee_mode,
       d.fixed_fee,
       d.min_order,
       d.free_delivery_above,
       d.allow_unlisted_neighborhoods
from public.delivery_settings d
join public.businesses b on b.id = d.business_id
where b.slug = 'estancia-treze';

-- 7.2 Bairros cadastrados (esperado: 0)
select count(*) as bairros
from public.delivery_zones z
join public.businesses b on b.id = z.business_id
where b.slug = 'estancia-treze';

-- 7.3 Políticas criadas (esperado: 2 em cada tabela)
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('delivery_settings', 'delivery_zones')
order by tablename, policyname;

-- 7.4 RLS realmente ligada (esperado: true nas duas)
select relname as tabela, relrowsecurity as rls_ligada
from pg_class
where oid in ('public.delivery_settings'::regclass, 'public.delivery_zones'::regclass);
