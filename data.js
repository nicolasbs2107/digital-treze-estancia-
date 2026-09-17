/* =====================================================================
   ESTÂNCIA TREZE PIZZARIA — CAMADA DE DADOS (Supabase)
   ---------------------------------------------------------------------
   Esta é a ÚNICA camada que conhece os nomes de coluna do banco.
   Ela devolve para o app.js exatamente o formato que ele já usava
   (CONFIG / CATEGORIAS / MENU), então nenhuma tradução de campo fica
   espalhada pelo resto do código.

   Organização:
   1. Cliente Supabase          5. Adaptador (banco -> formato do app)
   2. Relógio do servidor       6. Horário de funcionamento
   3. Preço vigente             7. Carregamento do cardápio
   4. Consultas                 8. Revalidação do carrinho
                                9. Diagnóstico no console
   ===================================================================== */
window.Cardapio = (function () {
  "use strict";

  const LOG = "%c[cardápio]";
  const ESTILO = "color:#C43A1E;font-weight:700";

  /* ---------- 1. CLIENTE -------------------------------------------- */
  let sb = null;

  function cliente() {
    if (sb) return sb;
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error("SDK do Supabase não carregou (verifique a tag <script> do CDN).");
    }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false }   // o cardápio público não faz login
    });
    return sb;
  }

  /* ---------- 1.1 TENANT (de qual empresa é este endereço?) ----------
     ÚNICO ponto do site que responde essa pergunta. A resposta oficial
     vem do banco, pela RPC public.resolve_business_by_domain(), a
     partir de window.location.hostname.

     O hostname vai CRU para a RPC: quem normaliza (minúsculas, porta,
     www., ponto final) é public.normalize_business_domain(), do lado do
     banco. Normalizar também aqui criaria duas regras que podem
     divergir com o tempo.

     Três desfechos, e só três:

       1 linha  -> { id, slug }. Esse id é o tenant da página, do
                   carregamento até o WhatsApp. Nada mais o troca.
       0 linhas -> ERRO_TENANT_DESCONHECIDO. O site não carrega NADA.
                   Nunca cai em outra empresa.
       falha    -> ERRO_TENANT_INDISPONIVEL (rede, RPC fora do ar,
                   permissão). Mensagem diferente, também sem fallback.

     ?loja=SLUG é ferramenta de desenvolvimento e só é lido quando a
     página está em host local. Em qualquer endereço publicado o
     parâmetro nem chega a ser consultado.
     ------------------------------------------------------------------ */
  const RPC_DOMINIO = "resolve_business_by_domain";
  const ERRO_TENANT_DESCONHECIDO = "tenant-desconhecido";
  const ERRO_TENANT_INDISPONIVEL = "tenant-indisponivel";

  function erroTenant(tipo, causa) {
    const e = new Error(tipo === ERRO_TENANT_DESCONHECIDO
      ? "Nenhum estabelecimento ativo para este endereço."
      : "Não foi possível resolver o estabelecimento deste endereço.");
    e.tenant = tipo;
    if (causa) e.causa = (causa && causa.message) || String(causa);
    return e;
  }

  function hostnameAtual() {
    try {
      return (window.location && window.location.hostname) ? String(window.location.hostname) : "";
    } catch (e) { return ""; }
  }

  /* Host de desenvolvimento: a máquina de quem está programando.
     Qualquer outra coisa — inclusive um endereço de teste publicado —
     é tratada como produção. */
  function ehHostLocal() {
    let protocolo = "";
    try { protocolo = (window.location && window.location.protocol) || ""; } catch (e) { protocolo = ""; }
    if (protocolo === "file:") return true;           // arquivo aberto direto do disco
    const h = hostnameAtual().toLowerCase();
    if (!h) return true;                              // sem hostname: não é um site publicado
    return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" ||
      h === "::1" || h === "[::1]" || /\.localhost$/.test(h);
  }

  /* Lido SÓ em host local. Em produção esta função nem é chamada. */
  function slugDeDesenvolvimento() {
    let slug = "";
    try {
      const p = new URLSearchParams(window.location.search);
      slug = (p.get("loja") || "").trim().toLowerCase();
    } catch (e) { slug = ""; }
    if (slug && /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return slug;
    return (typeof DEV_BUSINESS_SLUG !== "undefined" && DEV_BUSINESS_SLUG) ? DEV_BUSINESS_SLUG : "";
  }

  /* Tenant resolvido. Preenchido UMA vez e nunca mais trocado: as
     reconferências antes do WhatsApp leem daqui, não do endereço nem
     de nada digitado pelo visitante. */
  let TENANT = null;

  async function resolverPorDominio(host) {
    let resposta;
    try {
      resposta = await cliente().rpc(RPC_DOMINIO, { p_hostname: host });
    } catch (e) {
      throw erroTenant(ERRO_TENANT_INDISPONIVEL, e);
    }
    if (resposta && resposta.error) throw erroTenant(ERRO_TENANT_INDISPONIVEL, resposta.error);
    const linhas = Array.isArray(resposta.data) ? resposta.data : (resposta.data ? [resposta.data] : []);
    const linha = linhas[0];
    if (!linha || !linha.business_id) throw erroTenant(ERRO_TENANT_DESCONHECIDO);
    return { id: linha.business_id, slug: linha.slug || "", origem: "dominio", hostname: host };
  }

  /* Desenvolvimento apenas: descobre o id pelo slug. Não existe caminho
     que chegue aqui a partir de um endereço publicado. */
  async function resolverPorSlug(slug) {
    let resposta;
    try {
      resposta = await cliente().from("businesses").select("id,slug").eq("slug", slug).maybeSingle();
    } catch (e) {
      throw erroTenant(ERRO_TENANT_INDISPONIVEL, e);
    }
    if (resposta && resposta.error) throw erroTenant(ERRO_TENANT_INDISPONIVEL, resposta.error);
    if (!resposta.data || !resposta.data.id) throw erroTenant(ERRO_TENANT_DESCONHECIDO);
    return { id: resposta.data.id, slug: resposta.data.slug || slug, origem: "dev-slug", hostname: hostnameAtual() };
  }

  async function resolverTenant() {
    if (TENANT) return TENANT;
    const host = hostnameAtual();

    if (ehHostLocal()) {
      /* Em desenvolvimento o domínio ainda pode estar cadastrado
         (alguém apontou um /etc/hosts): tenta o caminho oficial antes de
         usar o slug. Só o "não encontrado" cai para o slug — uma falha
         de rede continua sendo falha de rede. */
      if (host) {
        try { TENANT = await resolverPorDominio(host); return TENANT; }
        catch (e) { if (e.tenant !== ERRO_TENANT_DESCONHECIDO) throw e; }
      }
      const slug = slugDeDesenvolvimento();
      if (!slug) throw erroTenant(ERRO_TENANT_DESCONHECIDO);
      TENANT = await resolverPorSlug(slug);
      return TENANT;
    }

    TENANT = await resolverPorDominio(host);
    return TENANT;
  }

  /* Tenant já resolvido, para as reconferências. Nunca resolve de novo:
     se por algum motivo não houver tenant, a reconferência falha em vez
     de sair procurando empresa. */
  function tenantAtual() {
    if (!TENANT || !TENANT.id) throw erroTenant(ERRO_TENANT_INDISPONIVEL);
    return TENANT;
  }

  /* ---------- 2. RELÓGIO DO SERVIDOR --------------------------------
     Ponto ÚNICO de tempo do site: promoções e horário de funcionamento
     leem daqui, nunca de `new Date()` espalhado pelo código.

     A referência é a RPC public.get_server_now(), consultada uma vez no
     carregamento. Antes de finalizar um pedido ela é consultada de novo,
     para pegar qualquer mudança.

     ENTRE UMA SINCRONIZAÇÃO E OUTRA o tempo avança por um relógio
     MONOTÔNICO (performance.now()), não por Date.now(). Guardamos o par:

        epocaServidorNaSync  — o instante que o servidor informou
        monotonicoNaSync     — a leitura monotônica do MESMO instante

     e a hora corrente é  epocaServidorNaSync + (monotonico() - monotonicoNaSync).

     Isso importa porque performance.now() não é afetado se o relógio do
     aparelho for alterado (pelo usuário, pelo sistema ou por uma correção
     de NTP) depois que sincronizamos: um salto de horas em Date.now() não
     move mais o status da loja. Date.now() só é usado DURANTE a medição da
     requisição e para diagnóstico.

     NÃO usamos o header HTTP Date da resposta.
     ------------------------------------------------------------------ */
  const RELOGIO = {
    origem: "cliente",
    confiavel: false,
    sincronizadoEm: null,
    epocaServidorNaSync: null,   // ms desde 1970, como o servidor informou
    monotonicoNaSync: null,      // leitura monotônica ancorada nesse instante
    rttMs: null,                 // ida e volta da chamada
    deslocamentoMs: 0            // só diagnóstico: o quanto o aparelho estava errado
  };
  const RPC_HORA = "get_server_now";

  /* Relógio monotônico. Date.now() é apenas o plano B para ambientes sem
     performance.now() — e nesse caso o aviso acima deixa de valer. */
  const monotonico = () =>
    (typeof performance !== "undefined" && performance && typeof performance.now === "function")
      ? performance.now()
      : Date.now();

  function agora() {
    /* nunca sincronizou: sobra o relógio do aparelho, já marcado como não
       confiável em RELOGIO.confiavel */
    if (RELOGIO.epocaServidorNaSync == null) return new Date();
    return new Date(RELOGIO.epocaServidorNaSync + (monotonico() - RELOGIO.monotonicoNaSync));
  }
  /* nome antigo, mantido para não quebrar quem já chamava */
  const agoraPromocional = agora;

  /* `ida` e `volta` são leituras MONOTÔNICAS que cercam a chamada: o
     instante devolvido pelo servidor corresponde, na melhor aproximação,
     ao meio do trajeto — é esse ponto do relógio monotônico que fica
     ancorado à hora do servidor. */
  function definirRelogioDoBanco(instanteISO, ida, volta) {
    const doBanco = new Date(instanteISO);
    if (isNaN(doBanco.getTime())) return false;
    const medido = typeof ida === "number" && typeof volta === "number" && volta >= ida;

    RELOGIO.epocaServidorNaSync = doBanco.getTime();
    RELOGIO.monotonicoNaSync = medido ? ida + (volta - ida) / 2 : monotonico();
    RELOGIO.rttMs = medido ? Math.round(volta - ida) : null;
    RELOGIO.deslocamentoMs = doBanco.getTime() - Date.now();
    RELOGIO.origem = "servidor";
    RELOGIO.confiavel = true;
    RELOGIO.sincronizadoEm = doBanco.toISOString();
    return true;
  }

  /* Falha aqui NÃO derruba o cardápio: o relógio continua marcado como
     não confiável e quem decide o que fazer com isso é o app. */
  async function sincronizarRelogio() {
    try {
      const ida = monotonico();
      const { data, error } = await cliente().rpc(RPC_HORA);
      const volta = monotonico();
      if (error) throw error;
      if (!definirRelogioDoBanco(data, ida, volta)) {
        throw new Error("Resposta de " + RPC_HORA + " não é uma data válida.");
      }
      return true;
    } catch (e) {
      console.warn("[cardápio] hora do servidor indisponível:", (e && e.message) || e);
      RELOGIO.origem = "cliente";
      RELOGIO.confiavel = false;
      return false;
    }
  }

  /* ---------- 3. PREÇO VIGENTE --------------------------------------
     Regra conservadora: na dúvida, cobra o preço normal.
     A JANELA (promo_start / promo_end) vem do produto.
     O VALOR promocional vem de cada tamanho — sem desconto proporcional,
     sem inventar nada. Tamanho sem promo_price simplesmente não tem promoção.
     ------------------------------------------------------------------ */
  function janelaAberta(produto, agora) {
    const inicio = produto.promo_start ? new Date(produto.promo_start) : null;
    const fim = produto.promo_end ? new Date(produto.promo_end) : null;
    if (!inicio && !fim) return false;                 // sem janela: não promove
    if (inicio && isNaN(inicio.getTime())) return false;
    if (fim && isNaN(fim.getTime())) return false;
    if (inicio && agora < inicio) return false;        // ainda não começou
    if (fim && agora >= fim) return false;             // já terminou
    return true;
  }

  function promocaoValida(normal, promocional) {
    return typeof promocional === "number" && promocional > 0 &&
      typeof normal === "number" && promocional < normal;
  }

  /* Devolve { preco, precoNormal, emPromocao } para um par de valores. */
  function resolverPreco(normal, promocional, produto, agora) {
    if (promocaoValida(normal, promocional) && janelaAberta(produto, agora)) {
      return { preco: promocional, precoNormal: normal, emPromocao: true };
    }
    return { preco: normal, precoNormal: normal, emPromocao: false };
  }

  /* ---------- 4. CONSULTAS ------------------------------------------
     Todas filtram por business_id — o id que veio da resolução do
     domínio. Nenhuma consulta do site público procura empresa por slug.
     ------------------------------------------------------------------ */
  async function buscarEmpresa(businessId) {
    const { data, error } = await cliente()
      .from("businesses").select("*").eq("id", businessId).single();
    if (error) throw error;
    return data;
  }

  async function buscarCategorias(businessId) {
    const { data, error } = await cliente()
      .from("categories").select("*")
      .eq("business_id", businessId)
      .order("position", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function buscarProdutos(businessId) {
    const { data, error } = await cliente()
      .from("products").select("*")
      .eq("business_id", businessId)
      .order("position", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  /* Regras de entrega: uma consulta para as configurações e outra para os
     bairros ATIVOS. Se qualquer uma falhar, o cardápio continua de pé e o
     delivery é que fica indisponível (nunca o contrário). */
  async function buscarEntrega(businessId) {
    try {
      const [cfg, zonas] = await Promise.all([
        cliente().from("delivery_settings").select("*").eq("business_id", businessId).maybeSingle(),
        cliente().from("delivery_zones").select("*")
          .eq("business_id", businessId).eq("active", true)
          .order("position", { ascending: true })
      ]);
      if (cfg.error) throw cfg.error;
      if (zonas.error) throw zonas.error;
      return mapearEntrega(cfg.data, zonas.data || []);
    } catch (e) {
      console.warn("[cardápio] configurações de entrega indisponíveis:", (e && e.message) || e);
      return {
        erro: true, enabled: false, feeMode: "confirm", fixedFee: null, minOrder: 0,
        freeDeliveryAbove: null, allowUnlistedNeighborhoods: true, zones: []
      };
    }
  }

  /* Estrutura única usada pelo checkout — nenhuma outra parte do site
     fala com as tabelas de entrega. */
  function mapearEntrega(cfg, zonas) {
    const c = cfg || {};
    return {
      erro: false,
      enabled: cfg ? c.enabled !== false : false,
      feeMode: ["confirm", "fixed", "by_neighborhood"].indexOf(c.fee_mode) >= 0 ? c.fee_mode : "confirm",
      fixedFee: numeroSolto(c.fixed_fee),
      minOrder: numeroSolto(c.min_order) || 0,
      freeDeliveryAbove: numeroSolto(c.free_delivery_above),
      allowUnlistedNeighborhoods: c.allow_unlisted_neighborhoods !== false,
      zones: (zonas || []).map(function (z) {
        return { id: z.id, nome: texto(z, "name", "nome"), taxa: numeroSolto(z.fee) || 0 };
      })
    };
  }

  /* Horário de funcionamento: business_hours (uma linha por dia) e
     business_hours_settings (fuso + pedidos fora do horário).
     Diferente da entrega, aqui o erro é devolvido com erro:true — o site
     precisa saber que NÃO sabe, para não afirmar que está aberto. */
  const FUSO_PADRAO = "America/Sao_Paulo";
  const BUCKET_MARCA = "business-assets";        // logo e favicon da empresa

  const horariosIndisponiveis = () => ({
    erro: true, timezone: FUSO_PADRAO, aceitarPedidosFechado: true, dias: []
  });

  async function buscarHorarios(businessId) {
    try {
      const [dias, cfg] = await Promise.all([
        cliente().from("business_hours").select("*")
          .eq("business_id", businessId)
          .order("day_of_week", { ascending: true }),
        cliente().from("business_hours_settings").select("*")
          .eq("business_id", businessId).maybeSingle()
      ]);
      if (dias.error) throw dias.error;
      if (cfg.error) throw cfg.error;
      const h = mapearHorarios(dias.data || [], cfg.data);
      /* fica registrado se a hora usada veio mesmo do servidor */
      h.relogioConfiavel = RELOGIO.confiavel;
      return h;
    } catch (e) {
      console.warn("[cardápio] horários indisponíveis:", (e && e.message) || e);
      return horariosIndisponiveis();
    }
  }

  /* "19:00:00" -> 1140 minutos. Aceita "19:00" e "19:00:00.000". */
  function minutosDoRelogio(v) {
    if (v == null || v === "") return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v));
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (isNaN(h) || isNaN(min) || h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function mapearHorarios(linhas, cfg) {
    const porDia = {};
    linhas.forEach(function (d) { porDia[Number(d.day_of_week)] = d; });

    const dias = [0, 1, 2, 3, 4, 5, 6].map(function (n) {
      const d = porDia[n];
      const abre = d ? minutosDoRelogio(d.opens_at) : null;
      const fecha = d ? minutosDoRelogio(d.closes_at) : null;
      /* dia só conta como aberto se o banco disser E os dois horários
         estiverem legíveis — sem horário, tratamos como fechado */
      const fechado = !d || d.is_closed === true || abre == null || fecha == null;
      return { dia: n, fechado: fechado, abre: fechado ? null : abre, fecha: fechado ? null : fecha };
    });

    const c = cfg || {};
    return {
      erro: false,
      timezone: (typeof c.timezone === "string" && c.timezone) ? c.timezone : FUSO_PADRAO,
      aceitarPedidosFechado: c.accept_orders_when_closed !== false,
      dias: dias
    };
  }

  /* A empresa, no formato que o site usa. Construída a partir da linha de
     `businesses` que JÁ foi buscada em carregar() — não existe consulta
     extra para nome ou WhatsApp em lugar nenhum do site.
     Tolerante a nomes de coluna alternativos, igual ao resto do adaptador. */
  function mapearEmpresa(linha) {
    const bruto = texto(linha, "whatsapp", "whatsapp_number", "phone", "telefone", "celular");
    const w = (window.Whats && window.Whats.normalizar)
      ? window.Whats.normalizar(bruto)
      : { ok: false, numero: "", exibicao: "", motivo: "whatsapp.js não carregou." };
    const insta = usuarioInstagram(texto(linha, "instagram"));
    /* Versão das imagens: muda só quando a linha da empresa é salva, então
       o navegador guarda a logo em cache normalmente entre uma visita e
       outra e só rebusca quando o dono troca a imagem no painel. */
    const versao = texto(linha, "updated_at") || texto(linha, "created_at") || "";
    const logoPath = texto(linha, "logo_path");
    const faviconPath = texto(linha, "favicon_path");

    return {
      id: linha.id,
      slug: texto(linha, "slug"),
      nome: texto(linha, "name", "nome"),
      atualizadoEm: versao,
      whatsapp: w.ok ? w.numero : "",
      whatsappExibicao: w.ok ? w.exibicao : "",
      whatsappValido: !!w.ok,
      whatsappMotivo: w.ok ? "" : w.motivo,
      /* perfil público */
      descricao: texto(linha, "short_description", "descricao"),
      instagram: insta,
      instagramUrl: insta ? "https://www.instagram.com/" + insta + "/" : "",
      /* identidade visual: o banco guarda só o caminho; a URL é montada
         aqui pelo próprio SDK, com a versão para furar o cache */
      logoPath: logoPath,
      faviconPath: faviconPath,
      logoUrl: urlDoBucket(logoPath, versao),
      faviconUrl: urlDoBucket(faviconPath, versao),
      endereco: {
        rua: texto(linha, "address_street"),
        numero: texto(linha, "address_number"),
        bairro: texto(linha, "address_neighborhood"),
        complemento: texto(linha, "address_complement"),
        cidade: texto(linha, "address_city"),
        estado: texto(linha, "address_state").toUpperCase(),
        cep: texto(linha, "address_postal_code")
      }
    };
  }

  /* URL pública de um objeto do bucket da identidade visual. Quem monta a
     URL é o próprio SDK — nada de endereço escrito à mão — e o "?v=" usa
     businesses.updated_at, não a hora atual: assim o cache do navegador só
     é descartado quando a empresa é realmente salva no painel. */
  function urlDoBucket(caminho, versao) {
    if (!caminho) return "";
    try {
      const r = cliente().storage.from(BUCKET_MARCA).getPublicUrl(caminho);
      const url = (r && r.data && r.data.publicUrl) || "";
      if (!url) return "";
      return versao ? url + "?v=" + encodeURIComponent(versao) : url;
    } catch (e) {
      console.warn("[cardápio] não foi possível montar a URL de " + caminho, e);
      return "";
    }
  }

  /* O painel já grava só o usuário. Aqui é rede de segurança para o caso
     de alguém editar a linha direto no banco: aceita @usuario ou a URL e
     recusa o que não parecer um usuário de verdade. */
  function usuarioInstagram(valor) {
    let s = String(valor == null ? "" : valor).trim();
    if (!s) return "";
    s = s.split(/[?#]/)[0]
      .replace(/^https?:\/\//i, "").replace(/^www\./i, "")
      .replace(/^(?:instagram\.com|instagr\.am)\//i, "")
      .replace(/^@+/, "").replace(/\/+$/, "").replace(/\s+/g, "");
    return /^[A-Za-z0-9._]{1,30}$/.test(s) ? s : "";
  }

  /* -------------------------------------------------------------------
     ENDEREÇO DO ESTABELECIMENTO — formatador único
     Nada aqui tem relação com o endereço de ENTREGA do cliente, que vive
     no checkout e continua intocado.

     Funciona com endereço parcial: cada pedaço só entra se existir, e
     nenhum separador sobra sozinho. Número sem rua é ignorado — sozinho
     não diz nada a ninguém.

        Rua Exemplo, 123 — Centro
        Fundos                      (só quando há complemento)
        Botucatu — SP
        CEP 18600-000
     ------------------------------------------------------------------- */
  function formatarEndereco(endereco) {
    const e = endereco || {};
    const v = (x) => String(x == null ? "" : x).trim();
    const rua = v(e.rua), numero = v(e.numero), bairro = v(e.bairro),
      complemento = v(e.complemento), cidade = v(e.cidade),
      estado = v(e.estado).toUpperCase(), cep = v(e.cep);

    const logradouro = rua ? (numero ? rua + ", " + numero : rua) : "";
    const local = [cidade, estado].filter(Boolean).join(" — ");

    const linhas = [];
    const primeira = [logradouro, bairro].filter(Boolean).join(" — ");
    if (primeira) linhas.push(primeira);
    if (complemento) linhas.push(complemento);
    if (local) linhas.push(local);
    if (cep) linhas.push("CEP " + cep);

    /* uma linha só, para o rodapé: "Rua X, 123 — Centro · Botucatu — SP" */
    const resumo = [primeira, local].filter(Boolean).join(" · ");

    /* Mapa só quando dá para chegar a um ponto: rua com cidade ou CEP,
       ou o CEP sozinho. Cidade solta abriria o mapa do município inteiro,
       o que não ajuda ninguém a encontrar a casa. */
    const consulta = [logradouro, bairro, cidade, estado, cep].filter(Boolean).join(", ");
    const podeMapear = !!((rua && (cidade || cep)) || cep);

    return {
      linhas: linhas,
      resumo: resumo,
      consulta: consulta,
      vazio: linhas.length === 0,
      podeMapear: podeMapear,
      mapaUrl: podeMapear
        ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(consulta)
        : ""
    };
  }

  /* ---------- 5. ADAPTADOR ------------------------------------------
     Converte as linhas do banco para EXATAMENTE o formato que o app.js
     já consome hoje. Tolerante a diferenças de nomenclatura: aceita
     name/nome, price/preco, etc., para que uma divergência de cadastro
     não derrube o cardápio.
     ------------------------------------------------------------------ */
  const texto = (o, ...chaves) => {
    for (const k of chaves) if (o && o[k] != null && o[k] !== "") return String(o[k]);
    return "";
  };
  const numero = (o, ...chaves) => {
    for (const k of chaves) {
      if (o && o[k] != null && o[k] !== "") {
        const n = Number(o[k]);
        if (!isNaN(n)) return n;
      }
    }
    return null;
  };
  const lista = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === "string" && v.trim()) {
      try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; }
    }
    return [];
  };
  const numeroSolto = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  };
  const identificador = (o, indice, prefixo) =>
    texto(o, "id", "slug", "codigo") ||
    (texto(o, "name", "nome").toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-")) ||
    (prefixo + indice);

  /* Cada tamanho carrega DOIS preços independentes: o da pizza inteira e
     o da metade, usado na montagem do meio a meio.

     O preço da metade NUNCA é calculado — nada aqui divide `price` por
     dois. Ele existe se, e somente se, o painel gravou half_price, e
     vale exatamente o que foi gravado. half_price ausente, nulo, não
     numérico ou <= 0 significa uma coisa só: este tamanho deste sabor
     não participa do meio a meio, e os três campos saem nulos/false.

     A promoção da metade usa a MESMA janela promo_start/promo_end do
     produto e a MESMA resolverPreco() do preço inteiro — não existe
     período separado nem regra paralela. */
  function mapearTamanhos(produto, agora) {
    return lista(produto.sizes).map(function (t, i) {
      const normal = numero(t, "price", "preco");
      const promo = numero(t, "promo_price", "preco_promocional");
      const r = resolverPreco(normal, promo, produto, agora);

      const metadeNormal = numero(t, "half_price", "preco_metade");
      const metadePromo = numero(t, "half_promo_price", "preco_promocional_metade");
      const temMetade = typeof metadeNormal === "number" && metadeNormal > 0;
      const m = temMetade ? resolverPreco(metadeNormal, metadePromo, produto, agora) : null;

      return {
        id: identificador(t, i, "tam-"),
        nome: texto(t, "name", "nome") || "Tamanho " + (i + 1),
        detalhe: texto(t, "detail", "detalhe", "description"),
        preco: r.preco,
        precoNormal: r.precoNormal,
        emPromocao: r.emPromocao,
        precoMetade: m ? m.preco : null,
        precoMetadeNormal: m ? m.precoNormal : null,
        metadeEmPromocao: m ? m.emPromocao : false
      };
    }).filter((t) => typeof t.preco === "number");
  }

  function mapearOpcionais(valor, prefixo) {
    return lista(valor).map(function (o, i) {
      return {
        id: identificador(o, i, prefixo),
        nome: texto(o, "name", "nome") || "Opção " + (i + 1),
        preco: numero(o, "price", "preco") || 0
      };
    });
  }

  function mapearProduto(p, categoriasPorId, agora) {
    const tamanhos = mapearTamanhos(p, agora);
    const ehPizza = tamanhos.length > 0;
    const simples = resolverPreco(numero(p, "price", "preco"), numero(p, "promo_price"), p, agora);
    const categoria = categoriasPorId[p.category_id];

    const produto = {
      id: p.id,
      nome: texto(p, "name", "nome"),
      descricao: texto(p, "description", "descricao"),
      categoria: categoria ? categoria.id : "outros",   // sempre slug, nunca uuid
      tipo: ehPizza ? "pizza" : "simples",
      destaque: p.featured === true,
      disponivel: p.available !== false,
      imagem: texto(p, "image_url", "imagem") || null,
      posicao: numero(p, "position") || 0,
      /* opções por produto, com o global de menu-data.js como padrão */
      opcoes: {
        tamanhos: tamanhos,
        bordas: mapearOpcionais(p.borders, "borda-"),
        adicionais: mapearOpcionais(p.addons, "add-")
      },
      /* mesmo formato de hoje, para o app.js não precisar saber de nada */
      precos: {},
      precosNormais: {},
      emPromocao: false
    };

    if (ehPizza) {
      tamanhos.forEach(function (t) {
        produto.precos[t.id] = t.preco;
        produto.precosNormais[t.id] = t.precoNormal;
        if (t.emPromocao) produto.emPromocao = true;
      });
    } else {
      produto.preco = simples.preco;
      produto.precoNormal = simples.precoNormal;
      produto.emPromocao = simples.emPromocao;
    }
    return produto;
  }

  const ICONE_PADRAO = {
    "pizzas-tradicionais": "🍕", "pizzas-especiais": "🥩",
    "pizzas-doces": "🍫", "bebidas": "🥤", "sobremesas": "🍨"
  };

  function mapearCategorias(linhas) {
    return linhas
      .filter((c) => c.active !== false)
      .map(function (c, i) {
        return {
          id: texto(c, "slug") || identificador(c, i, "cat-"),
          uuid: c.id,
          nome: texto(c, "name", "nome"),
          icone: texto(c, "icon", "icone") || ICONE_PADRAO[texto(c, "slug")] || "🍕",
          posicao: numero(c, "position") || i
        };
      });
  }

  /* ---------- 6. HORÁRIO DE FUNCIONAMENTO ----------------------------
     Todo o cálculo de "está aberto?" mora aqui, em UMA função. O resto
     do site apenas exibe o que ela devolve.

     Regras:
     · o instante vem do relógio do servidor (seção 2);
     · o dia e a hora são lidos no FUSO da empresa, nunca no do aparelho;
     · abertura inclusiva, fechamento exclusivo — às 23:00 em ponto já
       está fechado;
     · um turno com closes_at <= opens_at (ex.: 18:00 → 02:00) termina no
       DIA SEGUINTE, então o turno de ONTEM também é examinado.
     ------------------------------------------------------------------ */
  const DIAS_NOME = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  const DIAS_ABREV = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  const INDICE_SEMANA = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  const formatarHora = (minutos) =>
    String(Math.floor(minutos / 60) % 24).padStart(2, "0") + ":" +
    String(minutos % 60).padStart(2, "0");

  /* Dia da semana e minutos do dia NO FUSO DA EMPRESA. */
  function partesNoFuso(instante, timezone) {
    const ler = function (tz) {
      const partes = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        weekday: "short", hour: "2-digit", minute: "2-digit"
      }).formatToParts(instante);
      const v = {};
      partes.forEach(function (p) { v[p.type] = p.value; });
      const dia = INDICE_SEMANA[v.weekday];
      if (dia === undefined) throw new Error("dia da semana não reconhecido");
      /* alguns motores devolvem "24" à meia-noite */
      return { dia: dia, minutos: (Number(v.hour) % 24) * 60 + Number(v.minute), timezone: tz };
    };
    try { return ler(timezone); }
    catch (e) {
      try { return ler(FUSO_PADRAO); }
      catch (e2) {
        return {
          dia: instante.getDay(),
          minutos: instante.getHours() * 60 + instante.getMinutes(),
          timezone: null
        };
      }
    }
  }

  function calcularStatusFuncionamento(horarios, instante) {
    const quando = instante || agora();

    /* Sem dados confiáveis não afirmamos nada — e "confiável" inclui a
       hora: com o relógio do servidor fora do ar não dizemos se a casa
       está aberta, apenas que não foi possível confirmar. */
    if (!horarios || horarios.erro || horarios.relogioConfiavel === false ||
      !horarios.dias || horarios.dias.length !== 7) {
      return {
        erro: true, aberto: false, texto: "Horário indisponível", detalhe: "",
        timezone: (horarios && horarios.timezone) || FUSO_PADRAO,
        fechaEm: null, proximaAbertura: null, agora: null
      };
    }

    const tz = horarios.timezone || FUSO_PADRAO;
    const p = partesNoFuso(quando, tz);
    const dias = horarios.dias;

    let aberto = false, fechaEm = null;

    /* 1. turno que começou ONTEM e atravessa a meia-noite */
    const ontem = dias[(p.dia + 6) % 7];
    if (ontem && !ontem.fechado && ontem.fecha <= ontem.abre && p.minutos < ontem.fecha) {
      aberto = true; fechaEm = ontem.fecha;
    }

    /* 2. turno de HOJE */
    const hoje = dias[p.dia];
    if (!aberto && hoje && !hoje.fechado) {
      const atravessa = hoje.fecha <= hoje.abre;
      const dentro = atravessa
        ? p.minutos >= hoje.abre                                 // até a madrugada seguinte
        : (p.minutos >= hoje.abre && p.minutos < hoje.fecha);    // abre inclusivo, fecha exclusivo
      if (dentro) { aberto = true; fechaEm = hoje.fecha; }
    }

    if (aberto) {
      return {
        erro: false, aberto: true, texto: "Aberto agora",
        detalhe: "Fecha às " + formatarHora(fechaEm),
        timezone: p.timezone || tz, fechaEm: fechaEm,
        proximaAbertura: null, agora: { dia: p.dia, minutos: p.minutos }
      };
    }

    /* 3. próxima abertura: hoje (se ainda não começou) ou o próximo dia
          aberto da semana. Oito voltas cobrem também "só abre hoje". */
    let proxima = null;
    for (let k = 0; k < 8; k++) {
      const indice = (p.dia + k) % 7;
      const d = dias[indice];
      if (!d || d.fechado) continue;
      if (k === 0 && p.minutos >= d.abre) continue;   // o turno de hoje já passou
      const rotulo = k === 0 ? "hoje" : k === 1 ? "amanhã" : DIAS_NOME[indice];
      proxima = {
        diaIndice: indice, minutos: d.abre, emDias: k,
        rotulo: rotulo, hora: formatarHora(d.abre),
        texto: rotulo + " às " + formatarHora(d.abre)
      };
      break;
    }

    return {
      erro: false, aberto: false, texto: "Fechado no momento",
      detalhe: proxima ? "Abre " + proxima.texto : "",
      timezone: p.timezone || tz, fechaEm: null,
      proximaAbertura: proxima, agora: { dia: p.dia, minutos: p.minutos }
    };
  }

  /* ---------- 7. CARREGAMENTO --------------------------------------- */

  async function carregar() {
    /* PRIMEIRO de tudo: de quem é este endereço. Se isso não responder,
       nada mais acontece — nem relógio, nem cardápio, nem entrega. */
    const tenant = await resolverTenant();

    await sincronizarRelogio();          // uma única ida à rede pela hora
    const instante = agora();
    const empresa = await buscarEmpresa(tenant.id);
    const [linhasCategorias, linhasProdutos, entrega, horarios] = await Promise.all([
      buscarCategorias(tenant.id),
      buscarProdutos(tenant.id),
      buscarEntrega(tenant.id),
      buscarHorarios(tenant.id)
    ]);

    const categorias = mapearCategorias(linhasCategorias);
    const porUuid = {};
    categorias.forEach(function (c) { porUuid[c.uuid] = c; });

    /* Produtos indisponíveis continuam visíveis (com selo "Esgotado");
       quem impede de comprar é o app, não um filtro aqui. */
    const produtos = linhasProdutos.map((p) => mapearProduto(p, porUuid, instante));

    return {
      empresa: empresa,
      tenant: Object.assign({}, tenant),
      EMPRESA: mapearEmpresa(empresa),
      CATEGORIAS: categorias,
      MENU: produtos,
      ENTREGA: entrega,
      HORARIOS: horarios,
      bruto: { categorias: linhasCategorias, produtos: linhasProdutos },
      relogio: Object.assign({}, RELOGIO),
      carregadoEm: instante.toISOString()
    };
  }

  /* AS TRÊS RECONFERÊNCIAS ABAIXO usam sempre o MESMO business_id que o
     domínio resolveu no carregamento. Nenhuma delas resolve o tenant de
     novo, nenhuma delas olha para a URL: o pedido termina na empresa em
     que começou. */

  /* Releitura da empresa, usada na conferência final antes do WhatsApp:
     o dono pode ter trocado o número no painel com a página aberta. */
  async function recarregarEmpresa() {
    const linha = await buscarEmpresa(tenantAtual().id);
    return mapearEmpresa(linha);
  }

  /* Releitura leve, usada na conferência final antes do WhatsApp. */
  async function recarregarEntrega() {
    return buscarEntrega(tenantAtual().id);
  }

  /* Releitura do CARDÁPIO, usada na conferência final antes do WhatsApp.

     Enquanto o cliente monta o pedido — o que pode levar minutos ou
     horas com a aba aberta — o painel pode ter mudado preço, preço da
     metade, promoção, disponibilidade ou até apagado um tamanho. O MENU
     que está na memória da página é uma fotografia do momento em que
     ela carregou; conferir o carrinho contra ela seria conferir contra
     o passado.

     Aqui não existe caminho alternativo nenhum: o business_id vem de
     tenantAtual(), exatamente o mesmo que o domínio resolveu no
     carregamento. Nada de slug, nada de URL, nada de resolver empresa
     de novo — o pedido termina na empresa em que começou.

     As consultas e os adaptadores são os MESMOS do carregamento
     (buscarCategorias/buscarProdutos, mapearCategorias/mapearProduto),
     e o instante é agora(): é isso que faz promo_price e
     half_promo_price serem resolvidos de novo, pela regra de sempre,
     sem uma segunda lógica de preço em lugar nenhum.

     Falha aqui PROPAGA. Não devolvemos cardápio pela metade nem o
     antigo: quem chamou precisa saber que não deu, para bloquear o
     envio em vez de mandar preço velho. */
  async function recarregarMenu() {
    const id = tenantAtual().id;
    const instante = agora();

    const [linhasCategorias, linhasProdutos] = await Promise.all([
      buscarCategorias(id),
      buscarProdutos(id)
    ]);

    const categorias = mapearCategorias(linhasCategorias);
    const porUuid = {};
    categorias.forEach(function (c) { porUuid[c.uuid] = c; });

    return {
      CATEGORIAS: categorias,
      MENU: linhasProdutos.map((p) => mapearProduto(p, porUuid, instante)),
      relidoEm: instante.toISOString()
    };
  }

  /* Idem para o horário: hora do servidor renovada + tabelas relidas. */
  async function recarregarHorarios() {
    await sincronizarRelogio();
    let id;
    try { id = tenantAtual().id; }
    catch (e) {
      console.warn("[cardápio] empresa indisponível ao reconferir horários:", (e && e.message) || e);
      return horariosIndisponiveis();
    }
    /* Um relógio que não respondeu NÃO invalida os horários por si só:
       quem decide se isso impede o pedido é o app, e só quando a casa
       bloqueia pedidos fora do horário. */
    return buscarHorarios(id);
  }

  /* ---------- 8. REVALIDAÇÃO DO CARRINHO ----------------------------
     Confere item por item contra o cardápio atual. Não olha só o id:
     verifica existência, disponibilidade, tamanho, borda, adicionais e
     preço. Devolve o que fazer com cada item — quem mostra o aviso e
     decide é a camada de interface, na etapa em que isso for ligado.
     ------------------------------------------------------------------ */
  function revalidarCarrinho(carrinho, menu) {
    const problemas = [];
    const porId = {};
    (menu || []).forEach(function (p) { porId[p.id] = p; });

    (carrinho || []).forEach(function (item) {
      const p = porId[item.produtoId];

      if (!p) {
        problemas.push({
          uid: item.uid, nome: item.nome, tipo: "produto-removido",
          acao: "remover", aviso: item.nome + " saiu do cardápio e foi removido do pedido."
        });
        return;
      }
      if (p.disponivel === false) {
        problemas.push({
          uid: item.uid, nome: p.nome, tipo: "indisponivel",
          acao: "remover", aviso: p.nome + " está indisponível no momento."
        });
        return;
      }

      /* tamanho e preço base */
      let precoBase = null;

      /* --- meio a meio: DOIS sabores para conferir ---
         Um item antigo não tem esta chave, e ausência vale false: ele cai
         inteiro no caminho de sempre, logo abaixo. */
      if (item.meioAMeio === true) {
        const p2 = porId[item.segundoProdutoId];
        const nome2 = item.sabor2Nome || (p2 && p2.nome) || "o segundo sabor";
        const rotulo = "Pizza meio a meio";

        if (!item.segundoProdutoId || !p2) {
          problemas.push({
            uid: item.uid, nome: rotulo, tipo: "sabor2-removido", acao: "reconfigurar",
            aviso: nome2 + " saiu do cardápio. Monte a pizza meio a meio novamente."
          });
          return;
        }
        if (p2.disponivel === false) {
          problemas.push({
            uid: item.uid, nome: rotulo, tipo: "sabor2-indisponivel", acao: "reconfigurar",
            aviso: p2.nome + " está indisponível no momento. Monte a pizza meio a meio novamente."
          });
          return;
        }

        /* o MESMO tamanho precisa existir nos dois sabores */
        const t1 = (p.opcoes.tamanhos || []).find((x) => x.id === item.tamanhoId);
        const t2 = (p2.opcoes.tamanhos || []).find((x) => x.id === item.tamanhoId);
        if (!t1 || !t2) {
          problemas.push({
            uid: item.uid, nome: rotulo, tipo: "tamanho-removido", acao: "reconfigurar",
            aviso: "O tamanho escolhido não está mais disponível nos dois sabores. Monte a pizza meio a meio novamente."
          });
          return;
        }

        /* e os dois precisam continuar aceitando meio a meio naquele
           tamanho — o dono pode ter apagado o preço da metade no painel */
        const m1 = typeof t1.precoMetade === "number" && t1.precoMetade > 0;
        const m2 = typeof t2.precoMetade === "number" && t2.precoMetade > 0;
        if (!m1 || !m2) {
          problemas.push({
            uid: item.uid, nome: rotulo, tipo: "metade-indisponivel", acao: "reconfigurar",
            aviso: (m1 ? p2.nome : p.nome) + " não é mais oferecido em meio a meio neste tamanho. Monte a pizza novamente."
          });
          return;
        }

        /* soma das DUAS metades — nunca o inteiro, nunca a média */
        precoBase = t1.precoMetade + t2.precoMetade;

      } else if (p.tipo === "pizza") {
        const t = p.opcoes.tamanhos.find((x) => x.id === item.tamanhoId);
        if (!t) {
          problemas.push({
            uid: item.uid, nome: p.nome, tipo: "tamanho-removido",
            acao: "reconfigurar", aviso: "O tamanho escolhido para " + p.nome + " não existe mais. Monte o produto novamente."
          });
          return;
        }
        precoBase = t.preco;
      } else {
        precoBase = p.preco;
      }

      /* borda */
      let precoExtras = 0;
      if (item.bordaId) {
        const b = p.opcoes.bordas.find((x) => x.id === item.bordaId);
        if (!b) {
          problemas.push({
            uid: item.uid, nome: p.nome, tipo: "borda-removida",
            acao: "reconfigurar", aviso: "A borda escolhida para " + p.nome + " não está mais disponível. Monte o produto novamente."
          });
          return;
        }
        precoExtras += b.preco;
      }

      /* adicionais */
      const sumidos = [];
      (item.adicionais || []).forEach(function (a) {
        const atual = p.opcoes.adicionais.find((x) => x.id === a.id);
        if (!atual) sumidos.push(a.nome);
        else precoExtras += atual.preco;
      });
      if (sumidos.length) {
        problemas.push({
          uid: item.uid, nome: p.nome, tipo: "adicional-removido",
          acao: "reconfigurar",
          aviso: "Estes adicionais de " + p.nome + " não existem mais: " + sumidos.join(", ") + ". Monte o produto novamente."
        });
        return;
      }

      /* preço — para o meio a meio, precoBase já é a soma das metades e
         precoExtras veio do produto principal, cobrado uma única vez */
      if (precoBase !== item.precoBase || precoExtras !== item.precoExtras) {
        const rotulo = item.meioAMeio === true ? "a pizza meio a meio" : p.nome;
        problemas.push({
          uid: item.uid, nome: rotulo, tipo: "preco-alterado", acao: "atualizar",
          de: item.precoBase + item.precoExtras, para: precoBase + precoExtras,
          precoBase: precoBase, precoExtras: precoExtras,
          aviso: "O preço de " + rotulo + " foi atualizado."
        });
      }
    });

    return { problemas: problemas, ok: problemas.length === 0 };
  }

  /* ---------- 9. DIAGNÓSTICO NO CONSOLE ------------------------------
     Só contagens e nomes — nunca chave, token ou dado sensível.
     ------------------------------------------------------------------ */
  function registrar(dados) {
    if (typeof DEBUG_CARDAPIO !== "undefined" && !DEBUG_CARDAPIO) return;
    const empresa = dados.EMPRESA || {};
    const t = dados.tenant || TENANT || {};
    console.groupCollapsed("%c[Supabase]", ESTILO + ";font-size:12px");
    console.log("Empresa:    " + (empresa.nome || t.slug || "(sem nome)"));
    console.log("Tenant:     " + (t.id || "?") + (t.slug ? " · " + t.slug : "") +
      " · resolvido por " + (t.origem === "dominio" ? ("domínio " + (t.hostname || "?")) : "slug de desenvolvimento"));
    console.log("WhatsApp:   " + (empresa.whatsappValido
      ? empresa.whatsapp + " (" + empresa.whatsappExibicao + ")"
      : "INVÁLIDO — " + (empresa.whatsappMotivo || "não cadastrado")));
    console.log("Categorias: " + dados.CATEGORIAS.length);
    console.log("Produtos:   " + dados.MENU.length +
      " (" + dados.MENU.filter((p) => p.destaque).length + " em destaque, " +
      dados.MENU.filter((p) => !p.disponivel).length + " esgotado(s))");
    console.log("Fonte:      " + DATA_SOURCE);
    if (dados.ENTREGA) {
      console.log("Entrega:    " + (dados.ENTREGA.erro ? "indisponível"
        : (dados.ENTREGA.enabled ? "ativa · modo " + dados.ENTREGA.feeMode +
          " · " + dados.ENTREGA.zones.length + " bairro(s)" : "desativada")));
    }
    if (dados.HORARIOS) {
      const h = dados.HORARIOS;
      if (h.erro) {
        console.log("Horários:   indisponíveis");
      } else {
        const s = calcularStatusFuncionamento(h);
        console.log("Horários:   " + h.dias.filter((d) => !d.fechado).length + " dia(s) aberto(s)" +
          " · fuso " + h.timezone +
          " · pedidos fora do horário: " + (h.aceitarPedidosFechado ? "aceitos" : "bloqueados"));
        console.log("Agora:      " + s.texto + (s.detalhe ? " · " + s.detalhe : ""));
      }
    }
    console.log("Relógio:    " + RELOGIO.origem +
      (RELOGIO.confiavel
        ? " (RPC " + RPC_HORA + ", rtt " + (RELOGIO.rttMs == null ? "?" : RELOGIO.rttMs) + "ms" +
        ", aparelho " + (RELOGIO.deslocamentoMs >= 0 ? "atrasado " : "adiantado ") +
        Math.abs(Math.round(RELOGIO.deslocamentoMs / 1000)) + "s" +
        "; avanço por relógio monotônico)"
        : " — hora do servidor indisponível"));
    console.groupEnd();
  }

  /* ---------- API ---------------------------------------------------- */
  const api = {
    cliente: cliente,
    carregar: carregar,
    /* tenant */
    resolverTenant: resolverTenant,
    tenant: function () { return TENANT ? Object.assign({}, TENANT) : null; },
    ehHostLocal: ehHostLocal,
    ERRO_TENANT_DESCONHECIDO: ERRO_TENANT_DESCONHECIDO,
    ERRO_TENANT_INDISPONIVEL: ERRO_TENANT_INDISPONIVEL,
    recarregarEmpresa: recarregarEmpresa,
    recarregarEntrega: recarregarEntrega,
    recarregarHorarios: recarregarHorarios,
    recarregarMenu: recarregarMenu,
    horariosIndisponiveis: horariosIndisponiveis,
    registrar: registrar,
    revalidarCarrinho: revalidarCarrinho,
    /* tempo */
    agora: agora,
    agoraPromocional: agoraPromocional,
    sincronizarRelogio: sincronizarRelogio,
    definirRelogioDoBanco: definirRelogioDoBanco,
    relogio: RELOGIO,
    /* empresa */
    formatarEndereco: formatarEndereco,
    /* horário de funcionamento */
    calcularStatusFuncionamento: calcularStatusFuncionamento,
    formatarHora: formatarHora,
    DIAS_NOME: DIAS_NOME,
    DIAS_ABREV: DIAS_ABREV,
    /* preço */
    resolverPreco: resolverPreco,
    ultimoDiagnostico: null
  };

  return api;
})();