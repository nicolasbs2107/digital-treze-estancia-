-- =====================================================================
-- ESTÂNCIA TREZE PIZZARIA — HORÁRIOS DE FUNCIONAMENTO
-- ---------------------------------------------------------------------
-- Cria as tabelas de horário, as políticas de RLS e os horários atuais
-- da Estância Treze.
--
-- Seguro para rodar mais de uma vez: "if not exists", "drop policy if
-- exists" e seeds com "on conflict do nothing" — reexecutar NÃO desfaz
-- ajustes feitos depois no painel.
--
-- Nenhum UUID escrito à mão (a empresa vem do slug) e nenhum uso de
-- service_role.
--
-- SOBRE HORÁRIOS QUE ATRAVESSAM A MEIA-NOITE
-- Um turno como sexta 18:00–02:00 é gravado na linha da SEXTA, com
-- opens_at = 18:00 e closes_at = 02:00. O banco NÃO exige que o
-- fechamento seja maior que a abertura: quando closes_at <= opens_at,
-- entende-se que o expediente termina no dia seguinte. Quem interpreta
-- isso é o site, sempre no fuso de business_hours_settings.timezone.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Conferências antes de criar qualquer coisa
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from public.businesses where slug = 'estancia-treze') then
    raise exception 'Empresa com slug "estancia-treze" não encontrada em public.businesses';
  end if;

  if to_regclass('public.business_members') is null then
    raise exception 'Tabela public.business_members não encontrada — ela é a base das políticas de RLS';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Função de vínculo com a empresa
--    Reaproveita a que já veio no delivery-schema.sql. Só cria se não
--    existir, para não sobrescrever uma versão ajustada.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.is_business_member(uuid)') is null then
    execute $f$
      create function public.is_business_member(p_business_id uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = public
      as $inner$
        select exists (
          select 1
          from public.business_members m
          where m.business_id = p_business_id
            and m.user_id = auth.uid()
        );
      $inner$;
    $f$;
    execute 'revoke all on function public.is_business_member(uuid) from public';
    execute 'grant execute on function public.is_business_member(uuid) to anon, authenticated';
    raise notice 'Função public.is_business_member criada.';
  else
    raise notice 'Função public.is_business_member já existia — mantida como está.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Funções de apoio
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

-- valida o fuso com mensagem clara (não dá para consultar tabela em CHECK)
create or replace function public.tg_validar_timezone()
returns trigger
language plpgsql
as $$
begin
  if new.timezone is null or not exists (
    select 1 from pg_timezone_names where name = new.timezone
  ) then
    raise exception 'Fuso horário inválido: %. Use um nome reconhecido, como America/Sao_Paulo.', new.timezone;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. business_hours — uma linha por empresa e dia da semana
--    0 = domingo ... 6 = sábado
-- ---------------------------------------------------------------------
create table if not exists public.business_hours (
  id          uuid        primary key default gen_random_uuid(),
  business_id uuid        not null references public.businesses (id) on delete cascade,
  day_of_week smallint    not null,
  is_closed   boolean     not null default false,
  opens_at    time,
  closes_at   time,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint business_hours_dia_check
    check (day_of_week between 0 and 6),

  -- uma configuração por empresa + dia
  constraint business_hours_empresa_dia_uk
    unique (business_id, day_of_week),

  -- fechado: sem horários. aberto: os dois preenchidos e diferentes entre si.
  -- (closes_at menor que opens_at é PERMITIDO: vira madrugada do dia seguinte)
  constraint business_hours_coerencia_check
    check (
      (is_closed is true  and opens_at is null and closes_at is null)
      or
      (is_closed is false and opens_at is not null and closes_at is not null
       and opens_at <> closes_at)
    )
);

comment on table  public.business_hours is 'Horário de funcionamento por dia da semana. 0 = domingo ... 6 = sábado.';
comment on column public.business_hours.closes_at is 'Se menor ou igual a opens_at, o expediente termina no dia seguinte (ex.: 18:00 às 02:00).';

create index if not exists business_hours_empresa_idx
  on public.business_hours (business_id, day_of_week);

drop trigger if exists set_updated_at on public.business_hours;
create trigger set_updated_at
  before update on public.business_hours
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- 4. business_hours_settings — uma linha por empresa
-- ---------------------------------------------------------------------
create table if not exists public.business_hours_settings (
  business_id               uuid        primary key
                              references public.businesses (id) on delete cascade,
  timezone                  text        not null default 'America/Sao_Paulo',
  accept_orders_when_closed boolean     not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on column public.business_hours_settings.timezone is 'Fuso usado para interpretar os horários — nunca o relógio do aparelho do cliente.';
comment on column public.business_hours_settings.accept_orders_when_closed is 'false bloqueia a finalização do pedido enquanto a loja estiver fechada.';

drop trigger if exists set_updated_at on public.business_hours_settings;
create trigger set_updated_at
  before update on public.business_hours_settings
  for each row execute function public.tg_set_updated_at();

drop trigger if exists validar_timezone on public.business_hours_settings;
create trigger validar_timezone
  before insert or update of timezone on public.business_hours_settings
  for each row execute function public.tg_validar_timezone();

-- ---------------------------------------------------------------------
-- 5. RLS
--    Leitura pública (o site precisa saber se está aberto).
--    Escrita apenas para quem administra AQUELA empresa.
-- ---------------------------------------------------------------------
alter table public.business_hours          enable row level security;
alter table public.business_hours_settings enable row level security;

grant select on public.business_hours, public.business_hours_settings to anon, authenticated;
grant insert, update, delete on public.business_hours, public.business_hours_settings to authenticated;

drop policy if exists business_hours_leitura_publica on public.business_hours;
create policy business_hours_leitura_publica
  on public.business_hours
  for select
  to anon, authenticated
  using (true);

drop policy if exists business_hours_gestao on public.business_hours;
create policy business_hours_gestao
  on public.business_hours
  for all
  to authenticated
  using      (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

drop policy if exists business_hours_settings_leitura_publica on public.business_hours_settings;
create policy business_hours_settings_leitura_publica
  on public.business_hours_settings
  for select
  to anon, authenticated
  using (true);

drop policy if exists business_hours_settings_gestao on public.business_hours_settings;
create policy business_hours_settings_gestao
  on public.business_hours_settings
  for all
  to authenticated
  using      (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));

-- ---------------------------------------------------------------------
-- 6. Horários atuais da Estância Treze
--    Domingo a quarta fechado · quinta a sábado 19:00–23:00
--    "do nothing" preserva o que for alterado no painel depois.
-- ---------------------------------------------------------------------
insert into public.business_hours (business_id, day_of_week, is_closed, opens_at, closes_at)
select b.id, d.dia, d.fechado, d.abre, d.fecha
from public.businesses b
cross join (values
  (0, true,  null::time, null::time),   -- domingo
  (1, true,  null,       null),         -- segunda
  (2, true,  null,       null),         -- terça
  (3, true,  null,       null),         -- quarta
  (4, false, '19:00',    '23:00'),      -- quinta
  (5, false, '19:00',    '23:00'),      -- sexta
  (6, false, '19:00',    '23:00')       -- sábado
) as d(dia, fechado, abre, fecha)
where b.slug = 'estancia-treze'
on conflict (business_id, day_of_week) do nothing;

insert into public.business_hours_settings (business_id, timezone, accept_orders_when_closed)
select b.id, 'America/Sao_Paulo', true
from public.businesses b
where b.slug = 'estancia-treze'
on conflict (business_id) do nothing;

commit;

-- =====================================================================
-- 7. CONFERÊNCIA
-- =====================================================================

-- 7.1 Os sete dias (esperado: dom a qua fechado, qui a sáb 19:00–23:00)
select h.day_of_week,
       case h.day_of_week
         when 0 then 'domingo' when 1 then 'segunda' when 2 then 'terça'
         when 3 then 'quarta'  when 4 then 'quinta'  when 5 then 'sexta'
         else 'sábado' end as dia,
       h.is_closed,
       h.opens_at,
       h.closes_at
from public.business_hours h
join public.businesses b on b.id = h.business_id
where b.slug = 'estancia-treze'
order by h.day_of_week;

-- 7.2 Configurações (esperado: America/Sao_Paulo e aceita pedidos fechado)
select s.timezone, s.accept_orders_when_closed
from public.business_hours_settings s
join public.businesses b on b.id = s.business_id
where b.slug = 'estancia-treze';

-- 7.3 Políticas criadas (esperado: 2 em cada tabela)
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('business_hours', 'business_hours_settings')
order by tablename, policyname;

-- 7.4 RLS ligada (esperado: true nas duas)
select relname as tabela, relrowsecurity as rls_ligada
from pg_class
where oid in ('public.business_hours'::regclass, 'public.business_hours_settings'::regclass);
