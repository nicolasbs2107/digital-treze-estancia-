/* =====================================================================
   PAINEL ADMINISTRATIVO — SISTEMA MULTITENANT
   ---------------------------------------------------------------------
   Usa a MESMA chave publicável do site público (../supabase-config.js).
   Nenhuma chave secreta, nenhum service_role, nenhuma senha de banco.
   Quem autoriza cada escrita é a RLS; o frontend ainda filtra tudo por
   business_id para nunca tentar sair da empresa do usuário logado.

   1. Cliente e estado        6. Produtos (lista)
   2. Utilidades e UI         7. Produto (formulário)
   3. Autenticação            8. Fotos (Storage)
   4. Empresa e dados         9. Categorias
   5. Navegação e dashboard  10. Entrega
                             11. Horários
                             12. Configurações
                             13. Domínios
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- 1. CLIENTE E ESTADO ----------------------------------- */
  const BUCKET = "product-images";
  const LIMITE_ARQUIVO = 8 * 1024 * 1024;      // 8 MB antes do redimensionamento
  const LARGURA_MAXIMA = 1000;                  // px, depois do redimensionamento

  /* identidade visual da empresa — bucket separado das fotos de produto */
  const BUCKET_MARCA = "business-assets";
  const LIMITE_MARCA = 5 * 1024 * 1024;         // 5 MB de arquivo escolhido
  const LOGO_MAX = 1200;                        // px no maior lado
  const FAVICON_LADO = 512;                     // px, sempre quadrado

  /* ---------- 1.1 O QUE VEIO NA URL --------------------------------
     LIDO ANTES DO createClient, e isso não é estilo: é obrigatório.

     Com detectSessionInUrl ligado, o SDK consome o "#access_token=...
     &type=invite" assim que é criado e APAGA o fragmento da barra de
     endereços. Se perguntássemos depois, já não haveria o que ler — e
     um convite ficaria indistinguível de um login comum.

     Por isso o retrato da URL é tirado aqui, de forma síncrona, antes
     de qualquer coisa tocar no Supabase.

     O link do convite chega assim:
       .../admin/#access_token=...&refresh_token=...&type=invite
     e um link vencido, assim:
       .../admin/#error=access_denied&error_code=otp_expired&...
     ------------------------------------------------------------------ */
  const ENTRADA = (function () {
    function ler(texto) {
      try { return new URLSearchParams(String(texto || "").replace(/^[#?]/, "")); }
      catch (e) { return new URLSearchParams(); }
    }
    let hash = new URLSearchParams(), busca = new URLSearchParams();
    try { hash = ler(window.location.hash); busca = ler(window.location.search); } catch (e) { /* nada */ }
    const pega = (k) => hash.get(k) || busca.get(k) || "";

    const tipo = pega("type");
    return {
      tipo: tipo,
      /* "recovery" entra junto de propósito: é o link de redefinir senha,
         que leva à MESMA tela. Sem ele, ligar o detectSessionInUrl abriria
         um buraco novo — o link de recuperação criaria sessão e jogaria a
         pessoa direto no painel, sem nunca pedir a senha nova. */
      primeiroAcesso: tipo === "invite" || tipo === "recovery",
      temToken: !!(pega("access_token") || pega("code") || pega("token_hash")),
      /* error e error_code vêm separados e dizem coisas diferentes:
         error = "access_denied", error_code = "otp_expired". Juntar os
         dois num campo só perderia justamente o que distingue
         "expirou" de "inválido". */
      erro: pega("error"),
      erroCodigo: pega("error_code"),
      erroDescricao: pega("error_description"),
      temErro: !!(pega("error") || pega("error_code"))
    };
  })();

  /* detectSessionInUrl: true — é o que permite ao SDK transformar o link
     do convite em sessão. Sem isso o link abre o painel e não acontece
     nada. O retrato acima já foi tirado, então nada se perde. */
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  /* ---------- MARCA DE "AINDA PRECISA CRIAR SENHA" -------------------
     Guarda o user.id de quem entrou por convite e ainda não definiu a
     senha.

     POR QUE localStorage E NÃO sessionStorage: a sessão do Supabase é
     persistente (persistSession: true) e sobrevive ao fechamento da
     aba. Uma marca em sessionStorage, não — ela some junto com a aba.
     O resultado seria o pior dos dois mundos: a pessoa fecha a aba na
     tela "Crie sua senha", reabre /admin/, a sessão ainda está lá, a
     marca não, e ela entra no painel sem nunca ter criado senha. A
     marca precisa durar pelo menos o mesmo tanto que a sessão dura.

     POR QUE GUARDA O user.id E NÃO UM "1": o navegador pode ser
     compartilhado. Uma marca solta faria o próximo usuário a entrar —
     outra pessoa, com senha já definida — cair na tela de criar senha
     por causa de um convite alheio que ficou pela metade. Guardando o
     id, a marca só vale para quem ela é.

     Some em três situações, e só nelas: a senha foi criada, o usuário
     saiu, ou aquele fluxo foi invalidado de vez.
     ------------------------------------------------------------------ */
  const CHAVE_PENDENTE = "painel.primeiro-acesso";

  const marcarPendente = (userId) => {
    if (!userId) return;
    try { localStorage.setItem(CHAVE_PENDENTE, String(userId)); }
    catch (e) { /* navegador sem localStorage: segue sem a marca */ }
  };

  /* Apaga SOMENTE se a marca for daquele usuário. Sem o id não apaga
     nada: uma marca que não sabemos de quem é pode ser de outra pessoa
     no meio do primeiro acesso dela. */
  const limparPendente = (userId) => {
    if (!userId) return;
    try {
      if (localStorage.getItem(CHAVE_PENDENTE) === String(userId)) {
        localStorage.removeItem(CHAVE_PENDENTE);
      }
    } catch (e) { /* nada a fazer */ }
  };

  const pendenteDe = (userId) => {
    if (!userId) return false;
    try { return localStorage.getItem(CHAVE_PENDENTE) === String(userId); }
    catch (e) { return false; }
  };

  const estado = {
    usuario: null,
    empresa: null,
    campoWhats: null,     // nome real da coluna de WhatsApp em businesses
    campoNome: "name",
    categorias: [],
    produtos: [],
    aba: "dashboard",
    filtro: { texto: "", categoria: "", status: "todos" },
    horarios: [],           // 7 linhas de business_hours
    horariosCfg: null,      // linha de business_hours_settings
    horariosCarregados: false,
    horariosSujo: false,    // há alterações não salvas?
    entrega: null,          // linha de delivery_settings da empresa
    zonas: [],              // delivery_zones da empresa
    entregaCarregada: false,
    dominios: [],             // business_domains da empresa
    dominiosCarregados: false,
    cfgSujo: false,         // Configurações: há alterações não salvas?
    /* identidade visual: o que está pendente até clicar em Salvar */
    marca: {
      logo: { arquivo: null, previa: "", remover: false },
      favicon: { arquivo: null, previa: "", remover: false }
    },
    carregando: false,
    salvando: false
  };

  /* ---------- 2. UTILIDADES E UI ------------------------------------ */
  const $ = (s, c) => (c || document).querySelector(s);
  const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));
  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const money = (v) => brl.format(Number(v) || 0);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const semAcento = (s) => String(s).normalize("NFD")
    .split("").filter((c) => { const k = c.charCodeAt(0); return k < 0x300 || k > 0x36f; })
    .join("").toLowerCase();
  const slug = (s) => semAcento(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
  /* Aceita tanto o que o usuário digita ("54,90", "1.234,50") quanto o que
     vem do banco ("54.9"). O último separador é sempre o decimal; ponto com
     três casas depois é separador de milhar. */
  const numeroOuNulo = (v) => {
    if (v == null) return null;
    let t = String(v).trim().replace(/R\$/gi, "").replace(/\s/g, "");
    if (!t) return null;
    const temVirgula = t.indexOf(",") >= 0, temPonto = t.indexOf(".") >= 0;
    if (temVirgula && temPonto) {
      t = t.lastIndexOf(",") > t.lastIndexOf(".")
        ? t.replace(/\./g, "").replace(",", ".")
        : t.replace(/,/g, "");
    } else if (temVirgula) {
      t = t.replace(/\./g, "").replace(",", ".");
    } else if (temPonto) {
      const partes = t.split(".");
      if (partes.length > 2 || partes[partes.length - 1].length === 3) t = t.replace(/\./g, "");
    }
    const n = Number(t);
    return isNaN(n) ? null : n;
  };

  /* Mostra valores em formato brasileiro nos campos do formulário. */
  const precoTexto = (v) => {
    if (v == null || v === "") return "";
    const n = Number(v);
    return isNaN(n) ? String(v) : n.toFixed(2).replace(".", ",");
  };
  const paraCampoData = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  };
  const deCampoData = (v) => (v ? new Date(v).toISOString() : null);

  let toastTimer = null;
  function toast(texto, tipo) {
    const el = $("#toast");
    el.className = "toast" + (tipo === "erro" ? " erro" : "");
    el.innerHTML = '<span aria-hidden="true">' + (tipo === "erro" ? "!" : "✓") + "</span><span>" + esc(texto) + "</span>";
    el.classList.add("visivel");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visivel"), 2600);
  }

  function mensagemErro(e) {
    const m = (e && (e.message || e.error_description)) || "";
    if (/row-level security|violates|permission/i.test(m)) return "Você não tem permissão para esta alteração.";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Sem conexão com o servidor. Tente de novo.";
    return m || "Não foi possível concluir. Tente novamente.";
  }

  let aoFechar = null;
  function abrirFolha(titulo, corpo, rodape, fechou) {
    $("#folha-titulo").textContent = titulo;
    $("#folha-corpo").innerHTML = corpo;
    $("#folha-rodape").innerHTML = rodape || "";
    aoFechar = fechou || null;
    $("#cortina").hidden = false;
    $("#folha").hidden = false;
    $("#folha-corpo").scrollTop = 0;
    requestAnimationFrame(function () {
      $("#cortina").classList.add("aberta");
      $("#folha").classList.add("aberta");
    });
    document.body.classList.add("trava");
  }
  function fecharFolha() {
    $("#folha").classList.remove("aberta");
    $("#cortina").classList.remove("aberta");
    document.body.classList.remove("trava");
    setTimeout(function () {
      if (!$("#folha").classList.contains("aberta")) { $("#folha").hidden = true; $("#cortina").hidden = true; }
    }, 280);
    const cb = aoFechar; aoFechar = null;
    if (cb) cb();
  }

  function confirmar(titulo, texto, rotulo, acao) {
    abrirFolha(titulo,
      '<p style="color:var(--tinta-2)">' + esc(texto) + "</p>",
      '<button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>' +
      '<button type="button" class="btn btn-perigo" id="confirmar-acao">' + esc(rotulo) + "</button>");
    $("#confirmar-acao").onclick = function () {
      const btn = this;
      btn.classList.add("carregando"); btn.disabled = true;
      Promise.resolve(acao()).then(fecharFolha).catch(function (e) {
        btn.classList.remove("carregando"); btn.disabled = false;
        toast(mensagemErro(e), "erro");
      });
    };
  }

  const ocupado = (btn, sim) => {
    if (!btn) return;
    btn.classList.toggle("carregando", !!sim);
    btn.disabled = !!sim;
  };

  /* ---------- 3. AUTENTICAÇÃO --------------------------------------- */
  function mostrarTela(qual) {
    $("#tela-carregando").hidden = qual !== "carregando";
    $("#tela-login").hidden = qual !== "login";
    $("#tela-senha").hidden = qual !== "senha";
    $("#tela-painel").hidden = qual !== "painel";
  }

  /* Tira da barra de endereços tudo que o fluxo de e-mail deixou para
     trás. O SDK já limpa o fragmento sozinho ao processá-lo; isto é a
     segunda passada, que também cobre a query e o caso de o SDK não ter
     mexido (link vencido, por exemplo).

     replaceState e não pushState: o endereço com token não pode ficar no
     histórico do navegador — "voltar" não deve reabrir um link de acesso. */
  const PARAMS_DE_AUTH = [
    "access_token", "refresh_token", "expires_in", "expires_at", "token_type",
    "type", "provider_token", "provider_refresh_token",
    "code", "token_hash",
    "error", "error_code", "error_description"
  ];
  function limparUrl() {
    try {
      const url = new URL(window.location.href);
      let mudou = false;
      PARAMS_DE_AUTH.forEach(function (k) {
        if (url.searchParams.has(k)) { url.searchParams.delete(k); mudou = true; }
      });
      if (url.hash) { url.hash = ""; mudou = true; }
      if (mudou) {
        window.history.replaceState(null, document.title, url.pathname + url.search);
      }
    } catch (e) { /* URL exótica: melhor não mexer do que quebrar a página */ }
  }

  /* ---------- 3.1 PRIMEIRO ACESSO (CONVITE) -------------------------
     O convite já criou a sessão — o SDK cuidou disso. O que falta é a
     senha: sem ela a pessoa entra hoje e não consegue entrar amanhã.
     Por isso esta tela vem ANTES do painel, e não depois.
     ------------------------------------------------------------------ */
  const MIN_SENHA = 8;

  function telaCriarSenha(usuario) {
    marcarPendente(usuario && usuario.id);
    const alvo = $("#senha-email");
    const email = (usuario && usuario.email) || "";
    if (email) {
      alvo.innerHTML = "Você foi convidado como <b>" + esc(email) + "</b>. " +
        "Defina uma senha para acessar o painel.";
      alvo.hidden = false;
    } else {
      alvo.hidden = true;
    }
    $("#erro-senha").hidden = true;
    $("#nova-senha").value = "";
    $("#confirmar-senha").value = "";
    mostrarTela("senha");
    $("#nova-senha").focus();
  }

  async function criarSenha(ev) {
    ev.preventDefault();
    if (estado.carregando) return;                 // trava contra duplo clique

    const nova = $("#nova-senha").value;
    const confirma = $("#confirmar-senha").value;
    const btn = $("#btn-criar-senha");
    const erro = $("#erro-senha");
    erro.hidden = true;

    const reclamar = function (texto, campo) {
      erro.textContent = texto; erro.hidden = false;
      if (campo) campo.focus();
    };

    if (!nova || !confirma) return reclamar("Preencha os dois campos.", !nova ? $("#nova-senha") : $("#confirmar-senha"));
    if (nova.length < MIN_SENHA) return reclamar("A senha precisa ter pelo menos " + MIN_SENHA + " caracteres.", $("#nova-senha"));
    if (nova !== confirma) return reclamar("As senhas não são iguais.", $("#confirmar-senha"));

    estado.carregando = true; ocupado(btn, true);
    try {
      /* SOMENTE isto. É o próprio usuário, com a sessão dele, mudando a
         própria senha — nada de Admin API, nada de service_role, nada de
         chave secreta no navegador. */
      const { data, error } = await sb.auth.updateUser({ password: nova });
      if (error) throw error;

      $("#nova-senha").value = ""; $("#confirmar-senha").value = "";
      limparPendente((data && data.user && data.user.id) ||
        (estado.usuario && estado.usuario.id));
      limparUrl();                                  // tokens fora da barra de endereços

      /* A sessão continua valendo: daqui segue o caminho normal, que
         descobre a empresa por business_members. Nenhum business_id é
         escrito no código. */
      if (data && data.user) estado.usuario = data.user;
      await iniciarSessao();
    } catch (e) {
      console.error("[admin]", e);
      const m = (e && e.message) || "";
      if (/session|jwt|expired|not authenticated|Auth session missing/i.test(m)) {
        /* a sessão do convite venceu enquanto a pessoa digitava: este
           fluxo não vai se concluir, então a marca dele sai */
        limparPendente(estado.usuario && estado.usuario.id);
        limparUrl();
        await sb.auth.signOut().catch(function () { /* já estava fora */ });
        mostrarTela("login");
        const el = $("#erro-login");
        el.textContent = "Seu link de acesso expirou antes de a senha ser salva. Peça um novo convite ao responsável pelo site.";
        el.hidden = false;
        return;
      }
      reclamar(
        /at least|should be at least|weak|password/i.test(m)
          ? "Essa senha não foi aceita. Use pelo menos " + MIN_SENHA + " caracteres."
          : mensagemErro(e),
        $("#nova-senha")
      );
    } finally {
      estado.carregando = false; ocupado(btn, false);
    }
  }

  /* Link de convite que não vale mais: mensagem de gente, e volta para o
     login — nunca uma tela em branco ou um erro técnico do Supabase. */
  function conviteInvalido() {
    /* Sem sessão não há id — e apagar a marca "no escuro" poderia
       liberar o painel para outra pessoa que está no meio do primeiro
       acesso dela. Aqui só limpamos a URL e voltamos ao login. */
    limparUrl();
    mostrarTela("login");
    const el = $("#erro-login");
    const venceu = ENTRADA.erroCodigo === "otp_expired" ||
      /expired|expirou/i.test(ENTRADA.erroCodigo + " " + (ENTRADA.erroDescricao || ""));
    el.textContent = venceu
      ? "Este link de convite expirou. Peça um novo ao responsável pelo site."
      : "Este link de acesso não é mais válido. Peça um novo convite ao responsável pelo site.";
    el.hidden = false;
  }

  async function entrar(ev) {
    ev.preventDefault();
    if (estado.carregando) return;                 // trava contra duplo clique
    const email = $("#login-email").value.trim();
    const senha = $("#login-senha").value;
    const btn = $("#btn-entrar");
    const erro = $("#erro-login");
    erro.hidden = true;

    if (!email || !senha) {
      erro.textContent = "Preencha e-mail e senha."; erro.hidden = false; return;
    }

    estado.carregando = true; ocupado(btn, true);
    try {
      const { error } = await sb.auth.signInWithPassword({ email: email, password: senha });
      if (error) throw error;
      $("#login-senha").value = "";
      await iniciarSessao();
    } catch (e) {
      const m = (e && e.message) || "";
      erro.textContent = /Invalid login|invalid_credentials/i.test(m)
        ? "E-mail ou senha incorretos. Confira e tente de novo."
        : /Email not confirmed/i.test(m) ? "Este e-mail ainda não foi confirmado."
          : mensagemErro(e);
      erro.hidden = false;
      $("#login-senha").focus();
    } finally {
      estado.carregando = false; ocupado(btn, false);
    }
  }

  async function sair() {
    const quemSaiu = estado.usuario && estado.usuario.id;
    await sb.auth.signOut();
    limparPendente(quemSaiu);
    estado.usuario = null; estado.empresa = null;
    estado.produtos = []; estado.categorias = [];
    estado.entrega = null; estado.zonas = []; estado.entregaCarregada = false;
    estado.horarios = []; estado.horariosCfg = null;
    estado.horariosCarregados = false; estado.horariosSujo = false;
    mostrarTela("login");
  }

  /* ---------- 4. EMPRESA E DADOS ------------------------------------
     O UUID da empresa NUNCA é escrito no código: vem do vínculo do
     usuário em business_members.
     ------------------------------------------------------------------ */
  const CHAVES_EMPRESA = ["business_id", "company_id", "empresa_id"];
  const CHAVES_USUARIO = ["user_id", "member_id", "profile_id", "uid"];
  const CHAVES_WHATS = ["whatsapp", "whatsapp_number", "phone", "telefone", "celular"];

  async function descobrirEmpresa() {
    let r = await sb.from("business_members").select("*").eq("user_id", estado.usuario.id);
    if (r.error) r = await sb.from("business_members").select("*");   // coluna com outro nome
    if (r.error) throw r.error;

    const linhas = r.data || [];
    if (!linhas.length) return null;

    const minha = linhas.find(function (l) {
      return CHAVES_USUARIO.some((k) => l[k] === estado.usuario.id);
    }) || linhas[0];

    const chave = CHAVES_EMPRESA.find((k) => minha[k]);
    if (!chave) return null;

    const emp = await sb.from("businesses").select("*").eq("id", minha[chave]).single();
    if (emp.error) throw emp.error;

    estado.campoNome = ("name" in emp.data) ? "name" : (("nome" in emp.data) ? "nome" : "name");
    estado.campoWhats = CHAVES_WHATS.find((k) => k in emp.data) || null;
    return emp.data;
  }

  async function carregarDados() {
    const [cats, prods] = await Promise.all([
      sb.from("categories").select("*").eq("business_id", estado.empresa.id).order("position", { ascending: true }),
      sb.from("products").select("*").eq("business_id", estado.empresa.id).order("position", { ascending: true })
    ]);
    if (cats.error) throw cats.error;
    if (prods.error) throw prods.error;
    estado.categorias = cats.data || [];
    estado.produtos = prods.data || [];
  }

  async function iniciarSessao() {
    mostrarTela("carregando");
    try {
      const empresa = await descobrirEmpresa();
      if (!empresa) {
        await sb.auth.signOut();
        mostrarTela("login");
        $("#erro-login").textContent = "Este usuário não está vinculado a nenhuma empresa. Fale com o responsável pelo site.";
        $("#erro-login").hidden = false;
        return;
      }
      estado.empresa = empresa;
      $("#topo-empresa").textContent = empresa[estado.campoNome] || "Painel";
      $("#topo-email").textContent = estado.usuario.email || "";
      await carregarDados();
      mostrarTela("painel");
      irPara(estado.aba);
    } catch (e) {
      console.error("[admin]", e);
      mostrarTela("login");
      $("#erro-login").textContent = mensagemErro(e);
      $("#erro-login").hidden = false;
    }
  }

  /* ---------- 5. NAVEGAÇÃO E DASHBOARD ------------------------------ */
  function irPara(aba) {
    estado.aba = aba;
    $$("[data-aba]").forEach(function (b) { b.setAttribute("aria-current", String(b.dataset.aba === aba)); });
    const alvo = $("#conteudo");
    alvo.scrollTop = 0;
    window.scrollTo({ top: 0 });
    if (aba === "produtos") renderProdutos();
    else if (aba === "categorias") renderCategorias();
    else if (aba === "entrega") renderEntrega();
    else if (aba === "horarios") renderHorarios();
    else if (aba === "dominios") renderDominios();
    else if (aba === "config") renderConfig();
    else renderDashboard();
  }

  const contagens = () => ({
    total: estado.produtos.length,
    disponiveis: estado.produtos.filter((p) => p.available !== false).length,
    esgotados: estado.produtos.filter((p) => p.available === false).length,
    destaques: estado.produtos.filter((p) => p.featured === true).length
  });

  function renderDashboard() {
    const c = contagens();
    const nome = estado.empresa[estado.campoNome] || "por aqui";
    $("#conteudo").innerHTML =
      '<h2 class="saudacao">Olá, ' + esc(nome) + " 👋</h2>" +
      "<p>Aqui você cuida do cardápio que aparece para os clientes.</p>" +
      '<div class="cartoes">' +
      cartao("Produtos cadastrados", c.total, "") +
      cartao("Produtos disponíveis", c.disponiveis, "disponivel") +
      cartao("Produtos esgotados", c.esgotados, "esgotado") +
      cartao("Produtos em destaque", c.destaques, "destaque") +
      "</div>" +
      '<div class="atalhos">' +
      '<button type="button" class="btn btn-principal" id="atalho-novo">+ Novo produto</button>' +
      '<button type="button" class="btn btn-secundario" data-aba-ir="produtos">Gerenciar produtos</button>' +
      "</div>" +
      '<div class="painel-caixa"><h3>Como funciona</h3>' +
      '<p class="dica">Tudo o que você mudar aqui aparece no cardápio assim que a página do cliente for recarregada. ' +
      'Marcar um produto como esgotado não apaga nada — ele volta com um toque. ' +
      'Produtos em destaque aparecem na aba “Mais pedidas”.</p></div>';

    $("#atalho-novo").onclick = () => abrirFormProduto(null);
  }
  const cartao = (rotulo, valor, classe) =>
    '<div class="cartao-num ' + classe + '"><div class="rotulo">' + rotulo + '</div><div class="valor">' + valor + "</div></div>";

  /* ---------- 6. PRODUTOS (LISTA) ----------------------------------- */
  const catPorId = (id) => estado.categorias.find((c) => c.id === id);
  const precoInicial = (p) => {
    const s = Array.isArray(p.sizes) ? p.sizes : [];
    if (s.length) return Math.min.apply(null, s.map((t) => Number(t.price) || 0));
    return Number(p.price) || 0;
  };

  function produtosFiltrados() {
    const t = semAcento(estado.filtro.texto);
    return estado.produtos.filter(function (p) {
      if (t && semAcento(p.name || "").indexOf(t) < 0) return false;
      if (estado.filtro.categoria && p.category_id !== estado.filtro.categoria) return false;
      if (estado.filtro.status === "disponiveis" && p.available === false) return false;
      if (estado.filtro.status === "esgotados" && p.available !== false) return false;
      if (estado.filtro.status === "destaques" && p.featured !== true) return false;
      return true;
    });
  }

  /* A TELA é desenhada uma vez ao entrar na aba: cabeçalho, filtros e um
     container vazio para a lista. O <input> de busca nunca é recriado
     enquanto se digita — era isso que fazia o cursor saltar. */
  function renderProdutos() {
    $("#conteudo").innerHTML =
      '<div class="cabeca-pagina"><div><h2>Produtos</h2><p>' + estado.produtos.length +
      " cadastrado(s) nesta empresa</p></div>" +
      '<button type="button" class="btn btn-principal" data-novo-produto>+ Novo produto</button></div>' +

      '<div class="filtros" id="filtros-produtos">' +
      '<div class="busca-caixa"><span class="lupa" aria-hidden="true">⌕</span>' +
      '<label class="invisivel" for="busca-prod">Buscar pelo nome</label>' +
      '<input class="entrada" id="busca-prod" type="search" autocomplete="off" placeholder="Buscar pelo nome..." value="' + esc(estado.filtro.texto) + '"></div>' +
      '<select class="entrada" id="filtro-cat" aria-label="Filtrar por categoria"><option value="">Todas as categorias</option>' +
      estado.categorias.map((c) => '<option value="' + c.id + '"' +
        (estado.filtro.categoria === c.id ? " selected" : "") + ">" + esc(c.name || c.nome) + "</option>").join("") +
      "</select>" +
      '<select class="entrada" id="filtro-status" aria-label="Filtrar por situação">' +
      ["todos:Todos", "disponiveis:Disponíveis", "esgotados:Esgotados", "destaques:Destaques"]
        .map(function (o) {
          const partes = o.split(":");
          return '<option value="' + partes[0] + '"' + (estado.filtro.status === partes[0] ? " selected" : "") + ">" + partes[1] + "</option>";
        }).join("") +
      "</select>" +
      "</div>" +

      '<div id="lista-produtos"></div>';

    /* listeners dos filtros: elementos recém-criados, atribuição direta */
    $("#busca-prod").oninput = function () {
      estado.filtro.texto = this.value;      // só o estado muda...
      renderListaProdutos();                 // ...e só a lista é redesenhada
    };
    $("#filtro-cat").onchange = function () {
      estado.filtro.categoria = this.value;
      renderListaProdutos();
    };
    $("#filtro-status").onchange = function () {
      estado.filtro.status = this.value;
      renderListaProdutos();
    };

    renderListaProdutos();
  }

  /* Única parte que muda ao filtrar. */
  function renderListaProdutos() {
    const alvo = $("#lista-produtos");
    if (!alvo) return;
    const lista = produtosFiltrados();

    alvo.innerHTML = lista.length
      ? '<div class="lista">' + lista.map(linhaProduto).join("") + "</div>"
      : '<div class="vazio"><div class="icone">🍕</div><strong>Nenhum produto encontrado.</strong>' +
      "<p>" + (estado.produtos.length ? "Tente mudar a busca ou os filtros." : "Cadastre o primeiro produto do cardápio.") + "</p>" +
      (estado.produtos.length ? "" : '<button type="button" class="btn btn-principal" data-novo-produto>+ Novo produto</button>') + "</div>";

    /* foto que não carrega vira o ícone — nunca fica imagem quebrada */
    $$(".linha-produto .foto img", alvo).forEach(function (img) {
      img.onerror = function () { img.parentElement.innerHTML = '<span aria-hidden="true">🍕</span>'; };
    });
  }

  function linhaProduto(p) {
    const cat = catPorId(p.category_id);
    const tamanhos = Array.isArray(p.sizes) ? p.sizes.length : 0;
    const disp = p.available !== false;
    return '<article class="linha-produto" data-id="' + p.id + '">' +
      '<div class="foto">' + (p.image_url
        ? '<img src="' + esc(p.image_url) + '" alt="" loading="lazy">'
        : '<span aria-hidden="true">🍕</span>') + "</div>" +
      "<div>" +
      '<div class="nome">' + esc(p.name) + "</div>" +
      '<div class="meta">' + esc(cat ? (cat.name || cat.nome) : "Sem categoria") +
      " · <b>" + money(precoInicial(p)) + "</b>" + (tamanhos ? " · " + tamanhos + " tamanhos" : "") + "</div>" +
      '<div class="etiquetas">' +
      (p.featured ? '<span class="etiqueta dourada">Destaque</span>' : "") +
      (tamanhos ? '<span class="etiqueta">Com tamanhos</span>' : '<span class="etiqueta">Preço único</span>') +
      "</div>" +
      "</div>" +
      '<div class="acoes-produto">' +
      '<button type="button" class="interruptor' + (disp ? " ligado" : "") + '" data-toggle="' + p.id + '">' +
      '<span class="bolinha"></span>' + (disp ? "Disponível" : "Esgotado") + "</button>" +
      '<span class="espaco"></span>' +
      '<button type="button" class="btn btn-secundario" data-editar="' + p.id + '">Editar</button>' +
      '<button type="button" class="btn btn-fantasma" data-excluir="' + p.id + '">Excluir</button>' +
      "</div>" +
      "</article>";
  }

  async function alternarDisponibilidade(id, botao) {
    const p = estado.produtos.find((x) => x.id === id);
    if (!p) return;
    const novo = !(p.available !== false);
    botao.disabled = true;
    const { data, error } = await sb.from("products")
      .update({ available: novo })
      .eq("id", id).eq("business_id", estado.empresa.id)   // filtro explícito, além da RLS
      .select();
    botao.disabled = false;
    if (error || !data || !data.length) { toast(mensagemErro(error), "erro"); return; }
    p.available = novo;
    botao.classList.toggle("ligado", novo);
    botao.innerHTML = '<span class="bolinha"></span>' + (novo ? "Disponível" : "Esgotado");
    toast(p.name + (novo ? " está disponível" : " marcado como esgotado"));
  }

  function pedirExclusao(id) {
    const p = estado.produtos.find((x) => x.id === id);
    if (!p) return;
    confirmar("Excluir " + p.name + "?", "Esta ação não poderá ser desfeita.", "Excluir produto", async function () {
      const { error } = await sb.from("products").delete()
        .eq("id", id).eq("business_id", estado.empresa.id);
      if (error) throw error;
      await removerFotoAntiga(p.image_url);
      estado.produtos = estado.produtos.filter((x) => x.id !== id);
      renderListaProdutos();
      toast("Produto excluído");
    });
  }

  /* ---------- 7. PRODUTO (FORMULÁRIO) ------------------------------- */
  let form = null;   // rascunho do produto em edição

  /* Um tamanho em branco. Existe como função porque três lugares criam
     tamanhos vazios (abrir o formulário, "+ Adicionar tamanho" e remover
     o último): com um literal repetido, acrescentar um campo novo — foi
     o caso de metade/promoMetade — deixaria um deles para trás.

     Campos de preço nascem "" e não 0: vazio quer dizer "não informado",
     e no meio a meio isso é a diferença entre "este sabor não entra" e
     "este sabor sai de graça". */
  const tamanhoVazio = () => ({ nome: "", detalhe: "", preco: "", promo: "", metade: "", promoMetade: "" });

  function abrirFormProduto(id) {
    const p = id ? estado.produtos.find((x) => x.id === id) : null;
    const tamanhos = p && Array.isArray(p.sizes) ? p.sizes : [];

    form = {
      id: p ? p.id : null,
      tipo: (!p || tamanhos.length) ? (p ? "tamanhos" : "tamanhos") : "simples",
      nome: p ? (p.name || "") : "",
      descricao: p ? (p.description || "") : "",
      categoria: p ? p.category_id : (estado.categorias[0] ? estado.categorias[0].id : ""),
      imagemUrl: p ? (p.image_url || "") : "",
      imagemAntiga: p ? (p.image_url || "") : "",
      arquivo: null,
      preco: p ? p.price : "",
      promo: p ? p.promo_price : "",
      inicio: p ? paraCampoData(p.promo_start) : "",
      fim: p ? paraCampoData(p.promo_end) : "",
      destaque: p ? p.featured === true : false,
      disponivel: p ? p.available !== false : true,
      /* half_price e half_promo_price são novos: produtos cadastrados
         antes do meio a meio simplesmente não têm essas chaves. O teste
         é `!= null`, que cobre tanto a chave ausente quanto o null
         gravado — e nos dois casos o campo abre VAZIO, nunca zero. Zero
         seria um preço de verdade; ausência é "não oferece". */
      tamanhos: tamanhos.length ? tamanhos.map((t) => ({
        nome: t.name || t.nome || "", detalhe: t.detail || t.detalhe || "",
        preco: t.price != null ? t.price : "", promo: t.promo_price != null ? t.promo_price : "",
        metade: t.half_price != null ? t.half_price : "",
        promoMetade: t.half_promo_price != null ? t.half_promo_price : ""
      })) : [tamanhoVazio()],
      bordas: p && Array.isArray(p.borders) ? p.borders.map((b) => ({ nome: b.name || b.nome || "", preco: b.price != null ? b.price : 0 })) : [],
      adicionais: p && Array.isArray(p.addons) ? p.addons.map((a) => ({ nome: a.name || a.nome || "", preco: a.price != null ? a.price : 0 })) : []
    };
    if (p && !tamanhos.length) form.tipo = "simples";

    abrirFolha(p ? "Editar produto" : "Novo produto", corpoFormProduto(),
      '<button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>' +
      '<button type="button" class="btn btn-principal" id="salvar-produto">' + (p ? "Salvar alterações" : "Cadastrar produto") + "</button>");

    ligarFormProduto();
  }

  function corpoFormProduto() {
    return '<div class="campo"><label for="f-nome">Nome do produto *</label>' +
      '<input id="f-nome" type="text" maxlength="80" placeholder="Ex.: Pizza Calabresa" value="' + esc(form.nome) + '"></div>' +

      '<div class="campo"><label for="f-desc">Descrição</label>' +
      '<textarea id="f-desc" maxlength="220" placeholder="Ingredientes principais">' + esc(form.descricao) + "</textarea></div>" +

      '<div class="campo"><label for="f-cat">Categoria *</label><select id="f-cat">' +
      (estado.categorias.length ? "" : '<option value="">Cadastre uma categoria primeiro</option>') +
      estado.categorias.map((c) => '<option value="' + c.id + '"' + (form.categoria === c.id ? " selected" : "") +
        ">" + esc(c.name || c.nome) + "</option>").join("") + "</select></div>" +

      '<div class="bloco-form" id="bloco-foto"><h4>Foto do produto</h4>' + editorFoto() + "</div>" +

      '<div class="bloco-form"><h4>Como este produto é vendido</h4>' +
      '<div class="escolha-tipo">' +
      '<button type="button" class="opcao-tipo' + (form.tipo === "simples" ? " ativa" : "") + '" data-tipo="simples">Produto simples<small>um preço só</small></button>' +
      '<button type="button" class="opcao-tipo' + (form.tipo === "tamanhos" ? " ativa" : "") + '" data-tipo="tamanhos">Com tamanhos<small>broto, média...</small></button>' +
      "</div>" +
      '<div id="area-precos">' + areaPrecos() + "</div>" +
      "</div>" +

      '<div class="bloco-form"><h4>Bordas</h4><div id="lista-bordas">' + listaOpcionais("bordas") + "</div>" +
      '<button type="button" class="add-item" data-add="bordas">+ Adicionar borda</button>' +
      '<p class="aviso-info">Sem nenhuma borda cadastrada, a seção não aparece para o cliente.</p></div>' +

      '<div class="bloco-form"><h4>Adicionais</h4><div id="lista-adicionais">' + listaOpcionais("adicionais") + "</div>" +
      '<button type="button" class="add-item" data-add="adicionais">+ Adicionar adicional</button></div>' +

      '<div class="bloco-form"><h4>Exibição no cardápio</h4>' +
      chaveLinha("destaque", "Produto em destaque", "Aparece na aba “Mais pedidas”", form.destaque) +
      chaveLinha("disponivel", "Disponível", "Desligado, aparece como esgotado e não pode ser pedido", form.disponivel) +
      "</div>" +

      '<p class="aviso-form" id="erro-form" hidden></p>';
  }

  function editorFoto() {
    return '<div class="foto-editor">' +
      '<div class="foto-previa" id="previa">' +
      (form.imagemUrl ? '<img src="' + esc(form.imagemUrl) + '" alt="">' : '<span aria-hidden="true">📷</span>') + "</div>" +
      '<div class="foto-acoes">' +
      '<input type="file" id="arquivo-foto" accept="image/png,image/jpeg,image/webp">' +
      '<button type="button" class="btn btn-secundario" id="escolher-foto">' + (form.imagemUrl ? "Trocar foto" : "Escolher foto") + "</button>" +
      (form.imagemUrl ? '<button type="button" class="btn btn-fantasma" id="tirar-foto">Remover foto</button>' : "") +
      '<span class="dica">JPG, PNG ou WebP, até 8 MB.<br>Sem foto, o cardápio usa a ilustração.</span>' +
      "</div></div>";
  }

  function areaPrecos() {
    if (form.tipo === "simples") {
      return '<div class="duas" style="margin-top:12px">' +
        '<div class="campo"><label for="f-preco">Preço *</label><input id="f-preco" inputmode="decimal" placeholder="0,00" value="' + esc(precoTexto(form.preco)) + '"></div>' +
        '<div class="campo"><label for="f-promo">Preço promocional</label><input id="f-promo" inputmode="decimal" placeholder="opcional" value="' + esc(precoTexto(form.promo)) + '"></div>' +
        "</div>" + janelaPromo();
    }
    /* Os quatro preços ficam numa faixa só, na ordem em que a casa
       pensa: inteira antes de metade, normal antes de promocional.
       Nome e detalhe atravessam a linha inteira (.largura-total) — no
       celular tudo empilha, e em nenhuma largura há rolagem lateral. */
    return '<div style="margin-top:12px">' +
      form.tamanhos.map(function (t, i) {
        return '<div class="linha-item linha-tamanho"><div class="campos tamanho">' +
          '<label class="largura-total"><span class="mini-rotulo">Tamanho</span><input data-tam="nome" data-i="' + i + '" placeholder="Ex.: Grande" value="' + esc(t.nome) + '"></label>' +
          '<label><span class="mini-rotulo">Preço inteiro *</span><input data-tam="preco" data-i="' + i + '" inputmode="decimal" placeholder="0,00" value="' + esc(precoTexto(t.preco)) + '"></label>' +
          '<label><span class="mini-rotulo">Preço metade</span><input data-tam="metade" data-i="' + i + '" inputmode="decimal" placeholder="opcional" value="' + esc(precoTexto(t.metade)) + '"></label>' +
          '<label><span class="mini-rotulo">Promo inteira</span><input data-tam="promo" data-i="' + i + '" inputmode="decimal" placeholder="opcional" value="' + esc(precoTexto(t.promo)) + '"></label>' +
          '<label><span class="mini-rotulo">Promo metade</span><input data-tam="promoMetade" data-i="' + i + '" inputmode="decimal" placeholder="opcional" value="' + esc(precoTexto(t.promoMetade)) + '"></label>' +
          '<label class="largura-total"><span class="mini-rotulo">Detalhe (opcional)</span><input data-tam="detalhe" data-i="' + i + '" placeholder="Ex.: 8 fatias · 35 cm" value="' + esc(t.detalhe) + '"></label>' +
          "</div>" +
          '<button type="button" class="remover-item" data-remove-tam="' + i + '" aria-label="Remover tamanho">×</button></div>';
      }).join("") +
      '<button type="button" class="add-item" data-add="tamanho">+ Adicionar tamanho</button>' +
      '<p class="dica dica-meio">O preço da metade é usado na montagem de pizzas meio a meio. ' +
      "Deixe em branco para não oferecer este sabor/tamanho no meio a meio.</p>" +
      "</div>" + janelaPromo();
  }

  function janelaPromo() {
    return '<div class="duas" style="margin-top:12px">' +
      '<div class="campo"><label for="f-inicio">Promoção começa em</label><input id="f-inicio" type="datetime-local" value="' + esc(form.inicio) + '"></div>' +
      '<div class="campo"><label for="f-fim">Promoção termina em</label><input id="f-fim" type="datetime-local" value="' + esc(form.fim) + '"></div>' +
      '</div><p class="aviso-info">Preencheu preço promocional? Informe pelo menos uma das datas. ' +
      "Fora desse período o cardápio mostra o preço normal.</p>";
  }

  function listaOpcionais(qual) {
    const itens = form[qual];
    if (!itens.length) return '<p class="dica">Nenhum item cadastrado.</p>';
    return itens.map(function (o, i) {
      return '<div class="linha-item"><div class="campos opcional">' +
        '<label><span class="mini-rotulo">Nome</span><input data-op="' + qual + '" data-campo="nome" data-i="' + i + '" placeholder="Ex.: Catupiry" value="' + esc(o.nome) + '"></label>' +
        '<label><span class="mini-rotulo">Preço adicional</span><input data-op="' + qual + '" data-campo="preco" data-i="' + i + '" inputmode="decimal" placeholder="0,00" value="' + esc(precoTexto(o.preco)) + '"></label>' +
        "</div>" +
        '<button type="button" class="remover-item" data-remove-op="' + qual + '" data-i="' + i + '" aria-label="Remover">×</button></div>';
    }).join("");
  }

  const chaveLinha = (id, titulo, sub, ligada) =>
    '<div class="interruptor-linha"><div class="texto">' + titulo + "<small>" + sub + "</small></div>" +
    '<button type="button" class="chave' + (ligada ? " ligada" : "") + '" data-chave="' + id + '" role="switch" aria-checked="' + !!ligada + '" aria-label="' + titulo + '"></button></div>';

  function guardarCampos() {
    if ($("#f-nome")) form.nome = $("#f-nome").value.trim();
    if ($("#f-desc")) form.descricao = $("#f-desc").value.trim();
    if ($("#f-cat")) form.categoria = $("#f-cat").value;
    if ($("#f-preco")) form.preco = $("#f-preco").value;
    if ($("#f-promo")) form.promo = $("#f-promo").value;
    if ($("#f-inicio")) form.inicio = $("#f-inicio").value;
    if ($("#f-fim")) form.fim = $("#f-fim").value;
  }

  function redesenharPrecos() {
    guardarCampos();
    $("#area-precos").innerHTML = areaPrecos();
  }

  /* Os eventos do formulário NÃO são registrados aqui: #folha-corpo é um
     elemento permanente do HTML, e registrar de novo a cada abertura fazia
     os listeners se acumularem (era a causa do "1 clique = vários tamanhos").
     A delegação vive em ligarEventos(), registrada uma vez só.
     Aqui ficam apenas os botões recriados a cada abertura, com onclick =,
     que é idempotente por natureza. */
  function ligarFormProduto() {
    $("#salvar-produto").onclick = salvarProduto;
  }

  /* --- handlers do formulário de produto (usados pela delegação única) --- */
  function formCliquou(ev) {
    const corpo = $("#folha-corpo");

    if (ev.target.closest("#escolher-foto")) { $("#arquivo-foto").click(); return; }
    if (ev.target.closest("#tirar-foto")) {
      if (!form) return;
      form.arquivo = null; form.imagemUrl = "";
      $("#bloco-foto").innerHTML = "<h4>Foto do produto</h4>" + editorFoto();
      return;
    }

    const tipo = ev.target.closest("[data-tipo]");
    const add = ev.target.closest("[data-add]");
    const remTam = ev.target.closest("[data-remove-tam]");
    const remOp = ev.target.closest("[data-remove-op]");
    const chave = ev.target.closest("[data-chave]");
    if (!(tipo || add || remTam || remOp || chave)) return;
    if (!form) return;                       // nenhum formulário aberto

    if (tipo) {
      guardarCampos();
      form.tipo = tipo.dataset.tipo;
      $$(".opcao-tipo", corpo).forEach((b) => b.classList.toggle("ativa", b === tipo));
      $("#area-precos").innerHTML = areaPrecos();
      return;
    }
    if (add) {
      guardarCampos();
      if (add.dataset.add === "tamanho") {
        form.tamanhos.push(tamanhoVazio());
        redesenharPrecos();
      } else {
        form[add.dataset.add].push({ nome: "", preco: "" });
        redesenharOpcionais(add.dataset.add);
      }
      return;
    }
    if (remTam) {
      guardarCampos();
      form.tamanhos.splice(Number(remTam.dataset.removeTam), 1);
      if (!form.tamanhos.length) form.tamanhos.push(tamanhoVazio());
      redesenharPrecos();
      return;
    }
    if (remOp) {
      guardarCampos();
      form[remOp.dataset.removeOp].splice(Number(remOp.dataset.i), 1);
      redesenharOpcionais(remOp.dataset.removeOp);
      return;
    }
    if (chave) {
      const campo = chave.dataset.chave;
      form[campo] = !form[campo];
      chave.classList.toggle("ligada", form[campo]);
      chave.setAttribute("aria-checked", String(form[campo]));
    }
  }

  function formDigitou(ev) {
    if (!form) return;
    const t = ev.target;
    if (t.dataset.tam) form.tamanhos[Number(t.dataset.i)][t.dataset.tam] = t.value;
    if (t.dataset.op) form[t.dataset.op][Number(t.dataset.i)][t.dataset.campo] = t.value;
  }

  function formMudou(ev) {
    if (ev.target.id === "arquivo-foto") escolherArquivo(ev.target.files[0]);
  }

  function redesenharOpcionais(qual) {
    const alvo = qual === "bordas" ? $("#lista-bordas") : $("#lista-adicionais");
    alvo.innerHTML = listaOpcionais(qual);
  }

  /* ---------- 8. FOTOS (STORAGE) ------------------------------------ */
  function escolherArquivo(file) {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) { toast("Use uma imagem JPG, PNG ou WebP", "erro"); return; }
    if (file.size > LIMITE_ARQUIVO) { toast("Imagem muito grande (máx. 8 MB)", "erro"); return; }
    form.arquivo = file;
    const leitor = new FileReader();
    leitor.onload = function () {
      form.imagemUrl = leitor.result;                       // só pré-visualização
      $("#previa").innerHTML = '<img src="' + leitor.result + '" alt="">';
      $("#escolher-foto").textContent = "Trocar foto";
    };
    leitor.readAsDataURL(file);
  }

  /* Reduz para no máximo 1000px e converte para WebP quando possível. */
  function redimensionar(file) {
    return new Promise(function (resolve) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        try {
          const escala = Math.min(1, LARGURA_MAXIMA / Math.max(img.width, img.height));
          const c = document.createElement("canvas");
          c.width = Math.round(img.width * escala);
          c.height = Math.round(img.height * escala);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(function (blob) { resolve(blob || file); }, "image/webp", 0.82);
        } catch (e) { resolve(file); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  async function enviarFoto(file) {
    const blob = await redimensionar(file);
    const ext = (blob.type && blob.type.indexOf("webp") >= 0) ? "webp"
      : (file.type.indexOf("png") >= 0 ? "png" : "jpg");
    /* pasta da empresa — as políticas do bucket conferem este primeiro nível */
    const caminho = estado.empresa.id + "/" +
      Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
    const { error } = await sb.storage.from(BUCKET).upload(caminho, blob, {
      contentType: blob.type || file.type, cacheControl: "3600", upsert: false
    });
    if (error) throw error;
    return sb.storage.from(BUCKET).getPublicUrl(caminho).data.publicUrl;
  }

  /* Remove a imagem anterior — só se for deste bucket e desta empresa. */
  async function removerFotoAntiga(url) {
    if (!url || url.indexOf("data:") === 0) return;
    const marca = "/" + BUCKET + "/";
    const i = url.indexOf(marca);
    if (i < 0) return;
    const caminho = decodeURIComponent(url.slice(i + marca.length).split("?")[0]);
    if (caminho.indexOf(estado.empresa.id + "/") !== 0) return;
    try { await sb.storage.from(BUCKET).remove([caminho]); }
    catch (e) { console.warn("[admin] não foi possível remover a imagem antiga:", e); }
  }

  /* ---------- salvar produto ---------------------------------------- */
  function idsUnicos(itens) {
    const usados = {};
    return itens.map(function (o) {
      let base = slug(o.nome);
      if (usados[base]) { usados[base] += 1; base = base + "-" + usados[base]; }
      else usados[base] = 1;
      return base;
    });
  }

  async function salvarProduto() {
    if (estado.salvando) return;
    guardarCampos();
    const erro = $("#erro-form");
    const mostrar = (m) => { erro.textContent = m; erro.hidden = false; $("#folha-corpo").scrollTop = $("#folha-corpo").scrollHeight; };
    erro.hidden = true;

    if (!form.nome) return mostrar("Informe o nome do produto.");
    if (!form.categoria) return mostrar("Escolha uma categoria.");

    let sizes = [], price = null, promo = null;
    if (form.tipo === "tamanhos") {
      const validos = form.tamanhos.filter((t) => t.nome.trim() && numeroOuNulo(t.preco) != null);
      if (!validos.length) return mostrar("Cadastre pelo menos um tamanho com nome e preço.");
      const ids = idsUnicos(validos);
      /* numeroOuNulo é a MESMA conversão dos outros preços do painel, e
         ela devolve null para campo vazio. É o que garante que "não
         informei" grave null em vez de 0 — nada aqui divide price por
         dois: o valor da metade é decisão da casa. */
      sizes = validos.map(function (t, i) {
        return {
          id: ids[i], name: t.nome.trim(), detail: (t.detalhe || "").trim(),
          price: numeroOuNulo(t.preco), promo_price: numeroOuNulo(t.promo),
          half_price: numeroOuNulo(t.metade), half_promo_price: numeroOuNulo(t.promoMetade)
        };
      });
      const ruim = sizes.find((x) => x.promo_price != null && x.promo_price >= x.price);
      if (ruim) return mostrar("O preço promocional de " + ruim.name + " precisa ser menor que o preço normal.");

      /* --- meio a meio ---
         Só conferimos o que foi preenchido. Metade em branco continua
         sendo uma resposta válida: quer dizer que aquele tamanho não
         entra no meio a meio. */
      const metadeInvalida = sizes.find((x) => x.half_price != null && !(x.half_price > 0));
      if (metadeInvalida) {
        return mostrar("O preço da metade de " + metadeInvalida.name + " precisa ser maior que zero. " +
          "Deixe em branco para não oferecer este tamanho no meio a meio.");
      }
      const promoSemMetade = sizes.find((x) => x.half_promo_price != null && x.half_price == null);
      if (promoSemMetade) {
        return mostrar("Para ter promoção da metade em " + promoSemMetade.name + ", informe antes o preço da metade.");
      }
      const promoMetadeInvalida = sizes.find((x) => x.half_promo_price != null && !(x.half_promo_price > 0));
      if (promoMetadeInvalida) {
        return mostrar("A promoção da metade de " + promoMetadeInvalida.name + " precisa ser maior que zero.");
      }
      const promoMetadeAlta = sizes.find((x) => x.half_promo_price != null && x.half_promo_price >= x.half_price);
      if (promoMetadeAlta) {
        return mostrar("A promoção da metade de " + promoMetadeAlta.name + " precisa ser menor que o preço da metade.");
      }

      price = Math.min.apply(null, sizes.map((s) => s.price));
      promo = null;                       // promoção de pizza vive em cada tamanho
    } else {
      price = numeroOuNulo(form.preco);
      promo = numeroOuNulo(form.promo);
      if (price == null) return mostrar("Informe o preço do produto.");
      if (promo != null && promo >= price) return mostrar("O preço promocional precisa ser menor que o preço normal.");
    }

    /* A promoção da metade usa a MESMA janela promo_start/promo_end do
       produto — não existe período separado. Por isso ela conta aqui:
       preencher só a promo da metade e nenhuma data deixaria o desconto
       sem período, exatamente como já acontecia com a promo inteira. */
    const temPromo = (promo != null) || sizes.some((s) => s.promo_price != null || s.half_promo_price != null);
    if (temPromo && !form.inicio && !form.fim) {
      return mostrar("Informe quando a promoção começa ou termina — sem período, o desconto não aparece no cardápio.");
    }

    const bordas = form.bordas.filter((b) => b.nome.trim());
    const adicionais = form.adicionais.filter((a) => a.nome.trim());
    const idsB = idsUnicos(bordas), idsA = idsUnicos(adicionais);

    const btn = $("#salvar-produto");
    estado.salvando = true; ocupado(btn, true);
    try {
      let imagem = form.imagemAntiga || null;
      if (form.arquivo) imagem = await enviarFoto(form.arquivo);
      else if (!form.imagemUrl) imagem = null;

      const dados = {
        business_id: estado.empresa.id,
        category_id: form.categoria,
        name: form.nome,
        description: form.descricao || null,
        image_url: imagem,
        price: price,
        promo_price: promo,
        promo_start: deCampoData(form.inicio),
        promo_end: deCampoData(form.fim),
        sizes: sizes,
        borders: bordas.map((b, i) => ({ id: idsB[i], name: b.nome.trim(), price: numeroOuNulo(b.preco) || 0 })),
        addons: adicionais.map((a, i) => ({ id: idsA[i], name: a.nome.trim(), price: numeroOuNulo(a.preco) || 0 })),
        featured: !!form.destaque,
        available: !!form.disponivel
      };

      let r;
      if (form.id) {
        r = await sb.from("products").update(dados)
          .eq("id", form.id).eq("business_id", estado.empresa.id).select();
      } else {
        const mesmaCat = estado.produtos.filter((p) => p.category_id === form.categoria);
        dados.position = mesmaCat.reduce((m, p) => Math.max(m, Number(p.position) || 0), 0) + 1;
        r = await sb.from("products").insert(dados).select();
      }
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw new Error("Nenhuma linha foi gravada — verifique suas permissões.");

      if (form.arquivo && form.imagemAntiga && form.imagemAntiga !== imagem) await removerFotoAntiga(form.imagemAntiga);
      if (!form.arquivo && !form.imagemUrl && form.imagemAntiga) await removerFotoAntiga(form.imagemAntiga);

      const salvo = r.data[0];
      const i = estado.produtos.findIndex((p) => p.id === salvo.id);
      if (i >= 0) estado.produtos[i] = salvo; else estado.produtos.push(salvo);

      fecharFolha();
      toast(form.id ? "Produto atualizado com sucesso." : "Produto cadastrado com sucesso.");
      irPara("produtos");
    } catch (e) {
      console.error("[admin]", e);
      mostrar(mensagemErro(e));
    } finally {
      estado.salvando = false; ocupado(btn, false);
    }
  }

  /* ---------- 9. CATEGORIAS ----------------------------------------- */
  const produtosDaCategoria = (id) => estado.produtos.filter((p) => p.category_id === id).length;

  function renderCategorias() {
    $("#conteudo").innerHTML =
      '<div class="cabeca-pagina"><div><h2>Categorias</h2><p>Ordem e nomes das abas do cardápio</p></div>' +
      '<button type="button" class="btn btn-principal" id="nova-cat">+ Nova categoria</button></div>' +
      (estado.categorias.length
        ? '<div class="lista">' + estado.categorias.map(function (c, i) {
          const qtd = produtosDaCategoria(c.id);
          const ativa = c.active !== false;
          return '<div class="linha-categoria' + (ativa ? "" : " inativa") + '">' +
            '<span class="icone" aria-hidden="true">' + esc(c.icon || "🍕") + "</span>" +
            '<div><div class="nome">' + esc(c.name || c.nome) + "</div>" +
            '<div class="contagem">' + qtd + " produto(s)" + (ativa ? "" : " · oculta no cardápio") + "</div></div>" +
            '<span class="espaco"></span>' +
            '<div class="setas">' +
            '<button type="button" class="seta" data-subir="' + c.id + '"' + (i === 0 ? " disabled" : "") + ' aria-label="Subir">↑</button>' +
            '<button type="button" class="seta" data-descer="' + c.id + '"' + (i === estado.categorias.length - 1 ? " disabled" : "") + ' aria-label="Descer">↓</button>' +
            "</div>" +
            '<button type="button" class="interruptor' + (ativa ? " ligado" : "") + '" data-cat-ativa="' + c.id + '">' +
            '<span class="bolinha"></span>' + (ativa ? "Ativa" : "Oculta") + "</button>" +
            '<button type="button" class="btn btn-secundario" data-cat-editar="' + c.id + '">Editar</button>' +
            '<button type="button" class="btn btn-fantasma" data-cat-excluir="' + c.id + '">Excluir</button>' +
            "</div>";
        }).join("") + "</div>"
        : '<div class="vazio"><div class="icone">🗂️</div><strong>Nenhuma categoria ainda.</strong>' +
        "<p>As categorias organizam o cardápio em abas.</p></div>");

    $("#nova-cat").onclick = () => abrirFormCategoria(null);
  }

  /* O ícone é cortado por CARACTERE VISÍVEL, não por unidade UTF-16.
     Emoji composto ocupa várias unidades — 👨‍🍳 ocupa 5, 🧑🏽‍🍳 ocupa 7 —
     e um corte cru quebraria a sequência no meio, gravando meio emoji no
     banco. Intl.Segmenter conta grafemas; onde ele não existir, o limite
     por unidade é generoso o bastante para não partir nada comum. */
  const MAX_ICONE = 2;                       // caracteres visíveis

  function limitarIcone(valor) {
    const s = String(valor == null ? "" : valor).trim();
    if (!s) return "";
    try {
      if (typeof Intl !== "undefined" && Intl.Segmenter) {
        const partes = Array.from(
          new Intl.Segmenter("pt-BR", { granularity: "grapheme" }).segment(s),
          (x) => x.segment
        );
        return partes.slice(0, MAX_ICONE).join("");
      }
    } catch (e) { /* sem Intl.Segmenter: usa o limite abaixo */ }
    return s.slice(0, 16);
  }

  function abrirFormCategoria(id) {
    const c = id ? estado.categorias.find((x) => x.id === id) : null;
    abrirFolha(c ? "Editar categoria" : "Nova categoria",
      '<div class="campo"><label for="c-nome">Nome *</label>' +
      '<input id="c-nome" maxlength="40" placeholder="Ex.: Pizzas especiais" value="' + esc(c ? (c.name || c.nome) : "") + '"></div>' +
      '<div class="campo"><label for="c-icone">Ícone</label>' +
      '<input id="c-icone" maxlength="20" placeholder="🍕" value="' + esc(c ? (c.icon || "") : "") + '">' +
      '<p class="dica">Um emoji. Em branco, o cardápio usa o ícone padrão.</p></div>' +
      '<p class="aviso-form" id="erro-cat" hidden></p>',
      '<button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>' +
      '<button type="button" class="btn btn-principal" id="salvar-cat">' + (c ? "Salvar" : "Criar categoria") + "</button>");

    $("#salvar-cat").onclick = async function () {
      const btn = this;
      const nome = $("#c-nome").value.trim();
      const icone = limitarIcone($("#c-icone").value);
      const erro = $("#erro-cat");
      erro.hidden = true;
      if (!nome) { erro.textContent = "Informe o nome da categoria."; erro.hidden = false; return; }
      ocupado(btn, true);
      try {
        let r;
        if (c) {
          r = await sb.from("categories").update({ name: nome, icon: icone || null })
            .eq("id", c.id).eq("business_id", estado.empresa.id).select();
        } else {
          const pos = estado.categorias.reduce((m, x) => Math.max(m, Number(x.position) || 0), 0) + 1;
          r = await sb.from("categories").insert({
            business_id: estado.empresa.id, name: nome, slug: slug(nome),
            icon: icone || null, position: pos, active: true
          }).select();
        }
        if (r.error) throw r.error;
        const salva = r.data[0];
        const i = estado.categorias.findIndex((x) => x.id === salva.id);
        if (i >= 0) estado.categorias[i] = salva; else estado.categorias.push(salva);
        fecharFolha();
        renderCategorias();
        toast(c ? "Categoria atualizada" : "Categoria criada");
      } catch (e) {
        erro.textContent = mensagemErro(e); erro.hidden = false;
      } finally { ocupado(btn, false); }
    };
  }

  async function alternarCategoria(id, botao) {
    const c = estado.categorias.find((x) => x.id === id);
    if (!c) return;
    const novo = !(c.active !== false);
    botao.disabled = true;
    const { data, error } = await sb.from("categories").update({ active: novo })
      .eq("id", id).eq("business_id", estado.empresa.id).select();
    botao.disabled = false;
    if (error || !data || !data.length) { toast(mensagemErro(error), "erro"); return; }
    c.active = novo;
    renderCategorias();
    toast(novo ? "Categoria visível no cardápio" : "Categoria oculta no cardápio");
  }

  async function moverCategoria(id, direcao) {
    const i = estado.categorias.findIndex((c) => c.id === id);
    const j = i + direcao;
    if (i < 0 || j < 0 || j >= estado.categorias.length) return;
    const a = estado.categorias[i], b = estado.categorias[j];
    const posA = Number(a.position) || i, posB = Number(b.position) || j;
    const r1 = await sb.from("categories").update({ position: posB }).eq("id", a.id).eq("business_id", estado.empresa.id);
    const r2 = await sb.from("categories").update({ position: posA }).eq("id", b.id).eq("business_id", estado.empresa.id);
    if (r1.error || r2.error) { toast(mensagemErro(r1.error || r2.error), "erro"); return; }
    a.position = posB; b.position = posA;
    estado.categorias.sort((x, y) => (Number(x.position) || 0) - (Number(y.position) || 0));
    renderCategorias();
  }

  function pedirExclusaoCategoria(id) {
    const c = estado.categorias.find((x) => x.id === id);
    if (!c) return;
    const qtd = produtosDaCategoria(c.id);
    if (qtd > 0) {
      abrirFolha("Não é possível excluir",
        "<p style=\"color:var(--tinta-2)\">A categoria <b>" + esc(c.name || c.nome) + "</b> ainda tem <b>" + qtd +
        " produto(s)</b>. Excluir agora deixaria esses produtos sem categoria no cardápio.</p>" +
        '<p class="aviso-info">Mova os produtos para outra categoria antes de excluir — ou apenas ' +
        "desative a categoria para escondê-la do cardápio sem perder nada.</p>",
        '<button type="button" class="btn btn-secundario" data-fechar>Entendi</button>');
      return;
    }
    confirmar("Excluir " + (c.name || c.nome) + "?", "Esta ação não poderá ser desfeita.", "Excluir categoria", async function () {
      const { error } = await sb.from("categories").delete().eq("id", id).eq("business_id", estado.empresa.id);
      if (error) throw error;
      estado.categorias = estado.categorias.filter((x) => x.id !== id);
      renderCategorias();
      toast("Categoria excluída");
    });
  }

  /* ---------- 10. ENTREGA -------------------------------------------
     Lê e grava delivery_settings (uma linha por empresa) e delivery_zones.
     Toda consulta filtra business_id explicitamente, além da RLS.
     Nesta etapa nada disso ainda é consumido pelo checkout público.
     ------------------------------------------------------------------ */
  const PADRAO_ENTREGA = {
    enabled: true, fee_mode: "confirm", fixed_fee: null,
    min_order: 0, free_delivery_above: null, allow_unlisted_neighborhoods: true
  };

  async function carregarEntrega() {
    const [cfg, zonas] = await Promise.all([
      sb.from("delivery_settings").select("*").eq("business_id", estado.empresa.id).maybeSingle(),
      sb.from("delivery_zones").select("*").eq("business_id", estado.empresa.id).order("position", { ascending: true })
    ]);
    if (cfg.error) throw cfg.error;
    if (zonas.error) throw zonas.error;
    /* empresa ainda sem linha de configuração: usa os padrões e cria ao salvar */
    estado.entrega = Object.assign({ business_id: estado.empresa.id }, PADRAO_ENTREGA, cfg.data || {});
    estado.zonas = zonas.data || [];
    estado.entregaCarregada = true;
  }

  function renderEntrega() {
    if (!estado.entregaCarregada) {
      $("#conteudo").innerHTML =
        '<div class="cabeca-pagina"><div><h2>Entrega</h2><p>Configure como os pedidos para delivery funcionam.</p></div></div>' +
        '<div class="painel-caixa"><div class="esq esq-linha" style="width:60%"></div>' +
        '<div class="esq esq-linha"></div><div class="esq esq-linha" style="width:40%"></div></div>' +
        '<div class="painel-caixa"><div class="esq esq-linha" style="width:50%"></div>' +
        '<div class="esq esq-linha"></div></div>';
      carregarEntrega()
        .then(function () { if (estado.aba === "entrega") renderEntrega(); })
        .catch(function (e) {
          console.error("[admin]", e);
          $("#conteudo").innerHTML =
            '<div class="cabeca-pagina"><div><h2>Entrega</h2></div></div>' +
            '<div class="vazio"><div class="icone">🚚</div><strong>Não foi possível carregar as configurações.</strong>' +
            "<p>" + esc(mensagemErro(e)) + "</p>" +
            '<button type="button" class="btn btn-principal" data-recarregar-entrega>Tentar novamente</button></div>';
        });
      return;
    }

    const e = estado.entrega;
    const temGratis = e.free_delivery_above != null;
    const porBairro = e.fee_mode === "by_neighborhood";

    $("#conteudo").innerHTML =
      '<div class="cabeca-pagina"><div><h2>Entrega</h2>' +
      "<p>Configure como os pedidos para delivery funcionam.</p></div></div>" +

      /* ligar/desligar */
      '<div class="painel-caixa">' +
      interruptorLinha("enabled", "Aceitar pedidos para entrega",
        "Quando desativado, a opção de delivery será ocultada do cardápio.", e.enabled) +
      "</div>" +

      /* modo da taxa */
      '<div class="painel-caixa"><h3>Como calcular a taxa de entrega?</h3>' +
      '<div class="escolha-modo">' +
      cartaoModo("confirm", "A confirmar", "A pizzaria confirma o valor da entrega pelo WhatsApp.", e.fee_mode) +
      cartaoModo("fixed", "Taxa fixa", "Todos os pedidos possuem a mesma taxa.", e.fee_mode) +
      cartaoModo("by_neighborhood", "Por bairro", "Cada bairro possui seu próprio valor de entrega.", e.fee_mode) +
      "</div>" +
      (e.fee_mode === "fixed"
        ? '<div class="campo campo-condicional"><label for="ent-fixa">Taxa de entrega</label>' +
        '<input id="ent-fixa" inputmode="decimal" placeholder="0,00" value="' + esc(precoTexto(e.fixed_fee)) + '"></div>'
        : "") +
      "</div>" +

      /* pedido mínimo */
      '<div class="painel-caixa"><h3>Pedido mínimo para delivery</h3>' +
      '<div class="campo"><label for="ent-minimo">Valor mínimo</label>' +
      '<input id="ent-minimo" inputmode="decimal" placeholder="0,00" value="' + esc(precoTexto(e.min_order || 0)) + '"></div>' +
      (Number(e.min_order) > 0
        ? '<p class="dica-inline">Pedidos abaixo de <b>' + money(e.min_order) + "</b> não poderão escolher entrega.</p>"
        : '<p class="dica-inline">Sem pedido mínimo.</p>') +
      "</div>" +

      /* entrega grátis */
      '<div class="painel-caixa">' +
      interruptorLinha("gratis", "Oferecer entrega grátis acima de determinado valor",
        "Acima do valor informado, a taxa de entrega deixa de ser cobrada.", temGratis) +
      (temGratis
        ? '<div class="campo campo-condicional"><label for="ent-gratis">Entrega grátis acima de</label>' +
        '<input id="ent-gratis" inputmode="decimal" placeholder="0,00" value="' + esc(precoTexto(e.free_delivery_above)) + '"></div>'
        : "") +
      "</div>" +

      /* bairros fora da lista */
      '<div class="painel-caixa">' +
      interruptorLinha("unlisted", "Aceitar pedidos de bairros não cadastrados",
        e.allow_unlisted_neighborhoods
          ? "O cliente poderá informar outro bairro e a taxa ficará a confirmar."
          : "Somente bairros cadastrados poderão selecionar Delivery.",
        e.allow_unlisted_neighborhoods) +
      "</div>" +

      '<p class="aviso-form" id="erro-entrega" hidden></p>' +
      '<button type="button" class="btn btn-principal btn-bloco" id="salvar-entrega" style="margin-top:16px">Salvar configurações de entrega</button>' +

      /* bairros */
      '<div class="painel-caixa" id="caixa-zonas"' + (porBairro ? "" : ' style="opacity:.72"') + ">" +
      '<div class="cabeca-pagina" style="margin-bottom:12px"><div><h3 style="font-size:15px">Bairros e taxas</h3>' +
      "<p>" + (porBairro
        ? "Cada bairro pode ter uma taxa diferente."
        : 'Estes valores só entram em uso quando o modo for <b>Por bairro</b>.') + "</p></div>" +
      '<button type="button" class="btn btn-secundario" data-nova-zona>+ Adicionar bairro</button></div>' +
      '<div id="lista-zonas"></div>' +
      "</div>";

    renderListaZonas();
    $("#salvar-entrega").onclick = salvarEntrega;
  }

  const cartaoModo = (valor, titulo, texto, atual) =>
    '<button type="button" class="opcao-tipo' + (atual === valor ? " ativa" : "") + '" data-modo="' + valor + '"' +
    ' role="radio" aria-checked="' + (atual === valor) + '">' + titulo + "<small>" + texto + "</small></button>";

  const interruptorLinha = (id, titulo, sub, ligada) =>
    '<div class="interruptor-linha"><div class="texto">' + titulo + "<small>" + sub + "</small></div>" +
    '<button type="button" class="chave' + (ligada ? " ligada" : "") + '" data-chave-entrega="' + id +
    '" role="switch" aria-checked="' + !!ligada + '" aria-label="' + esc(titulo) + '"></button></div>';

  function renderListaZonas() {
    const alvo = $("#lista-zonas");
    if (!alvo) return;
    if (!estado.zonas.length) {
      alvo.innerHTML = '<div class="vazio" style="padding:28px 16px"><div class="icone">📍</div>' +
        "<strong>Nenhum bairro cadastrado.</strong><p>Adicione os bairros que a pizzaria atende e a taxa de cada um.</p></div>";
      return;
    }
    alvo.innerHTML = '<div class="lista">' + estado.zonas.map(function (z, i) {
      const ativa = z.active !== false;
      return '<div class="linha-categoria linha-zona' + (ativa ? "" : " inativa") + '">' +
        '<span class="icone" aria-hidden="true">📍</span>' +
        '<div><div class="nome">' + esc(z.name) + "</div>" +
        '<div class="contagem taxa">' + money(z.fee) + (ativa ? "" : " · não aparece no cardápio") + "</div></div>" +
        '<span class="espaco"></span>' +
        '<div class="setas">' +
        '<button type="button" class="seta" data-zona-subir="' + z.id + '"' + (i === 0 ? " disabled" : "") + ' aria-label="Subir">↑</button>' +
        '<button type="button" class="seta" data-zona-descer="' + z.id + '"' + (i === estado.zonas.length - 1 ? " disabled" : "") + ' aria-label="Descer">↓</button>' +
        "</div>" +
        '<div class="acoes-zona">' +
        '<button type="button" class="interruptor' + (ativa ? " ligado" : "") + '" data-zona-ativa="' + z.id + '">' +
        '<span class="bolinha"></span>' + (ativa ? "Ativo" : "Inativo") + "</button>" +
        '<button type="button" class="btn btn-secundario" data-zona-editar="' + z.id + '">Editar</button>' +
        '<button type="button" class="btn btn-fantasma" data-zona-excluir="' + z.id + '">Excluir</button>' +
        "</div>" +
        "</div>";
    }).join("") + "</div>";
  }

  /* lê os campos digitados para o estado, sem redesenhar nada */
  function guardarEntrega() {
    const e = estado.entrega;
    if (!e) return;
    if ($("#ent-fixa")) e.fixed_fee = numeroOuNulo($("#ent-fixa").value);
    if ($("#ent-minimo")) e.min_order = numeroOuNulo($("#ent-minimo").value) || 0;
    if ($("#ent-gratis")) e.free_delivery_above = numeroOuNulo($("#ent-gratis").value);
  }

  function trocarModoEntrega(modo) {
    guardarEntrega();
    estado.entrega.fee_mode = modo;
    if (modo !== "fixed") estado.entrega.fixed_fee = null;
    renderEntrega();
  }

  function alternarChaveEntrega(qual) {
    guardarEntrega();
    const e = estado.entrega;
    if (qual === "enabled") e.enabled = !e.enabled;
    else if (qual === "unlisted") e.allow_unlisted_neighborhoods = !e.allow_unlisted_neighborhoods;
    else if (qual === "gratis") e.free_delivery_above = (e.free_delivery_above == null) ? 0 : null;
    renderEntrega();
  }

  async function salvarEntrega() {
    if (estado.salvando) return;
    guardarEntrega();
    const e = estado.entrega;
    const erro = $("#erro-entrega");
    const mostrar = (m) => { erro.textContent = m; erro.hidden = false; };
    erro.hidden = true;

    if (e.fee_mode === "fixed" && (e.fixed_fee == null))
      return mostrar("Informe a taxa de entrega para o modo Taxa fixa.");
    if (e.fixed_fee != null && e.fixed_fee < 0)
      return mostrar("A taxa de entrega não pode ser negativa.");
    if (e.min_order < 0)
      return mostrar("O pedido mínimo não pode ser negativo.");
    if (e.free_delivery_above != null && !(e.free_delivery_above > 0))
      return mostrar("Informe o valor a partir do qual a entrega é grátis.");

    const btn = $("#salvar-entrega");
    estado.salvando = true; ocupado(btn, true);
    try {
      const dados = {
        business_id: estado.empresa.id,
        enabled: !!e.enabled,
        fee_mode: e.fee_mode,
        fixed_fee: e.fee_mode === "fixed" ? e.fixed_fee : null,
        min_order: e.min_order || 0,
        free_delivery_above: e.free_delivery_above,
        allow_unlisted_neighborhoods: !!e.allow_unlisted_neighborhoods
      };
      const r = await sb.from("delivery_settings")
        .upsert(dados, { onConflict: "business_id" }).select();
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw new Error("Nenhuma linha foi gravada — verifique suas permissões.");
      estado.entrega = Object.assign({}, estado.entrega, r.data[0]);
      toast("Configurações de entrega salvas com sucesso.");
      renderEntrega();
    } catch (e2) {
      console.error("[admin]", e2);
      mostrar(mensagemErro(e2));
    } finally {
      estado.salvando = false; ocupado(btn, false);
    }
  }

  /* ----- bairros ----- */
  function abrirFormZona(id) {
    const z = id ? estado.zonas.find((x) => x.id === id) : null;
    abrirFolha(z ? "Editar bairro" : "Adicionar bairro",
      '<div class="campo"><label for="z-nome">Nome do bairro *</label>' +
      '<input id="z-nome" maxlength="60" placeholder="Ex.: Centro" value="' + esc(z ? z.name : "") + '"></div>' +
      '<div class="campo"><label for="z-taxa">Taxa de entrega</label>' +
      '<input id="z-taxa" inputmode="decimal" placeholder="0,00" value="' + esc(precoTexto(z ? z.fee : 0)) + '"></div>' +
      interruptorLinha("zona-ativa", "Ativo", "Bairros inativos não aparecem no cardápio.", z ? z.active !== false : true) +
      '<p class="aviso-form" id="erro-zona" hidden></p>',
      '<button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>' +
      '<button type="button" class="btn btn-principal" id="salvar-zona">' + (z ? "Salvar" : "Adicionar bairro") + "</button>");

    /* a chave do formulário guarda o estado no próprio botão */
    const chave = $('[data-chave-entrega="zona-ativa"]');
    chave.onclick = function () {
      const ligada = chave.classList.toggle("ligada");
      chave.setAttribute("aria-checked", String(ligada));
    };

    $("#salvar-zona").onclick = async function () {
      const btn = this;
      const erro = $("#erro-zona");
      erro.hidden = true;
      const nome = $("#z-nome").value.trim();
      const taxa = numeroOuNulo($("#z-taxa").value);
      const ativo = chave.classList.contains("ligada");
      if (!nome) { erro.textContent = "Informe o nome do bairro."; erro.hidden = false; return; }
      if (taxa == null) { erro.textContent = "Informe a taxa de entrega (use 0,00 para grátis)."; erro.hidden = false; return; }
      if (taxa < 0) { erro.textContent = "A taxa do bairro não pode ser negativa."; erro.hidden = false; return; }

      ocupado(btn, true);
      try {
        let r;
        if (z) {
          r = await sb.from("delivery_zones").update({ name: nome, fee: taxa, active: ativo })
            .eq("id", z.id).eq("business_id", estado.empresa.id).select();
        } else {
          const pos = estado.zonas.reduce((m, x) => Math.max(m, Number(x.position) || 0), 0) + 1;
          r = await sb.from("delivery_zones").insert({
            business_id: estado.empresa.id, name: nome, fee: taxa, active: ativo, position: pos
          }).select();
        }
        if (r.error) throw r.error;
        if (!r.data || !r.data.length) throw new Error("Nenhuma linha foi gravada — verifique suas permissões.");
        const salva = r.data[0];
        const i = estado.zonas.findIndex((x) => x.id === salva.id);
        if (i >= 0) estado.zonas[i] = salva; else estado.zonas.push(salva);
        fecharFolha();
        renderListaZonas();
        toast(z ? "Bairro atualizado com sucesso." : "Bairro adicionado.");
      } catch (e2) {
        const m = /duplicate key|unique/i.test((e2 && e2.message) || "")
          ? "Já existe um bairro com esse nome."
          : mensagemErro(e2);
        erro.textContent = m; erro.hidden = false;
      } finally { ocupado(btn, false); }
    };
  }

  async function alternarZona(id, botao) {
    const z = estado.zonas.find((x) => x.id === id);
    if (!z) return;
    const novo = !(z.active !== false);
    botao.disabled = true;
    const { data, error } = await sb.from("delivery_zones").update({ active: novo })
      .eq("id", id).eq("business_id", estado.empresa.id).select();
    botao.disabled = false;
    if (error || !data || !data.length) { toast(mensagemErro(error), "erro"); return; }
    z.active = novo;
    renderListaZonas();
    toast(novo ? z.name + " voltou para o cardápio" : z.name + " ficou inativo");
  }

  async function moverZona(id, direcao) {
    const i = estado.zonas.findIndex((z) => z.id === id);
    const j = i + direcao;
    if (i < 0 || j < 0 || j >= estado.zonas.length) return;
    const a = estado.zonas[i], b = estado.zonas[j];
    const posA = Number(a.position) || i, posB = Number(b.position) || j;
    const r1 = await sb.from("delivery_zones").update({ position: posB }).eq("id", a.id).eq("business_id", estado.empresa.id);
    const r2 = await sb.from("delivery_zones").update({ position: posA }).eq("id", b.id).eq("business_id", estado.empresa.id);
    if (r1.error || r2.error) { toast(mensagemErro(r1.error || r2.error), "erro"); return; }
    a.position = posB; b.position = posA;
    estado.zonas.sort((x, y) => (Number(x.position) || 0) - (Number(y.position) || 0));
    renderListaZonas();
  }

  function pedirExclusaoZona(id) {
    const z = estado.zonas.find((x) => x.id === id);
    if (!z) return;
    confirmar("Excluir bairro “" + z.name + "”?",
      "Essa taxa deixará de estar disponível no Delivery.", "Excluir", async function () {
        const { error } = await sb.from("delivery_zones").delete()
          .eq("id", id).eq("business_id", estado.empresa.id);
        if (error) throw error;
        estado.zonas = estado.zonas.filter((x) => x.id !== id);
        renderListaZonas();
        toast("Bairro excluído");
      });
  }

  /* ---------- 11. HORÁRIOS -------------------------------------------
     Lê e grava business_hours (7 linhas, uma por dia) e
     business_hours_settings. Nada disso é consumido pelo site público
     nesta etapa — o status "Aberto agora" continua como estava.
     ------------------------------------------------------------------ */
  const DIAS_SEMANA = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira",
    "Quinta-feira", "Sexta-feira", "Sábado"];
  const HORA_PADRAO = { abre: "18:00", fecha: "23:00" };

  /* "19:00:00" (banco) -> "19:00" (input type=time) */
  const soHoraMinuto = (v) => (v ? String(v).slice(0, 5) : "");

  async function carregarHorarios() {
    const [dias, cfg] = await Promise.all([
      sb.from("business_hours").select("*")
        .eq("business_id", estado.empresa.id).order("day_of_week", { ascending: true }),
      sb.from("business_hours_settings").select("*")
        .eq("business_id", estado.empresa.id).maybeSingle()
    ]);
    if (dias.error) throw dias.error;
    if (cfg.error) throw cfg.error;

    /* sempre sete dias, mesmo que alguma linha ainda não exista no banco */
    const porDia = {};
    (dias.data || []).forEach(function (d) { porDia[d.day_of_week] = d; });
    estado.horarios = [0, 1, 2, 3, 4, 5, 6].map(function (n) {
      const d = porDia[n];
      return {
        dia: n,
        fechado: d ? d.is_closed !== false : true,
        abre: d ? soHoraMinuto(d.opens_at) : "",
        fecha: d ? soHoraMinuto(d.closes_at) : ""
      };
    });
    estado.horariosCfg = cfg.data ||
      { business_id: estado.empresa.id, timezone: "America/Sao_Paulo", accept_orders_when_closed: true };
    estado.horariosCarregados = true;
    estado.horariosSujo = false;
  }

  function renderHorarios() {
    if (!estado.horariosCarregados) {
      $("#conteudo").innerHTML = cabecaHorarios() +
        '<div class="painel-caixa"><div class="esq esq-linha" style="width:45%"></div>' +
        '<div class="esq esq-linha"></div></div>' +
        '<div class="painel-caixa"><div class="esq esq-linha" style="width:45%"></div>' +
        '<div class="esq esq-linha"></div></div>';
      carregarHorarios()
        .then(function () { if (estado.aba === "horarios") renderHorarios(); })
        .catch(function (e) {
          console.error("[admin]", e);
          $("#conteudo").innerHTML = cabecaHorarios() +
            '<div class="vazio"><div class="icone">🕐</div><strong>Não foi possível carregar os horários.</strong>' +
            "<p>" + esc(mensagemErro(e)) + "</p>" +
            '<button type="button" class="btn btn-principal" data-recarregar-horarios>Tentar novamente</button></div>';
        });
      return;
    }

    const cfg = estado.horariosCfg;
    const aceita = cfg.accept_orders_when_closed !== false;
    $("#conteudo").innerHTML = cabecaHorarios() +
      '<div id="lista-dias">' + estado.horarios.map(cartaoDia).join("") + "</div>" +

      '<div class="painel-caixa"><h3>Pedidos fora do horário</h3>' +
      '<div class="interruptor-linha"><div class="texto">Aceitar pedidos quando o estabelecimento estiver fechado' +
      '<small id="texto-fora-horario">' + esc(textoForaHorario(aceita)) + "</small></div>" +
      '<button type="button" class="chave' + (aceita ? " ligada" : "") +
      '" data-chave-horario role="switch" aria-checked="' + aceita +
      '" aria-label="Aceitar pedidos fora do horário"></button></div>' +
      '<p class="fuso">Fuso horário: <b>' + esc(cfg.timezone || "America/Sao_Paulo") +
      "</b> · usado para saber se a loja está aberta.</p>" +
      "</div>" +

      '<p class="aviso-form" id="erro-horarios" hidden></p>' +
      '<div class="barra-salvar">' +
      '<span class="selo-sujo" id="selo-sujo"' + (estado.horariosSujo ? "" : " hidden") + ">Alterações não salvas</span>" +
      '<button type="button" class="btn btn-principal" id="salvar-horarios">Salvar horários</button>' +
      "</div>";

    $("#salvar-horarios").onclick = salvarHorarios;
  }

  const cabecaHorarios = () =>
    '<div class="cabeca-pagina"><div><h2>Horários de funcionamento</h2>' +
    "<p>Defina os dias e horários em que seu estabelecimento atende.</p></div></div>";

  const textoForaHorario = (ligado) => ligado
    ? "Os clientes poderão finalizar pedidos mesmo quando o estabelecimento estiver fechado."
    : "O checkout poderá bloquear novos pedidos fora do horário de funcionamento.";

  /* O fechamento no dia seguinte é normal (ex.: 18:00 → 02:00). */
  const fechaNoDiaSeguinte = (d) =>
    !d.fechado && d.abre && d.fecha && d.fecha <= d.abre;

  function cartaoDia(d) {
    const aberto = !d.fechado;
    return '<div class="dia-horario' + (aberto ? " aberto" : "") + '" id="dia-' + d.dia + '">' +
      '<div class="dia-topo">' +
      '<div><div class="dia-nome">' + DIAS_SEMANA[d.dia] + "</div>" +
      '<div class="dia-estado">' + (aberto
        ? (d.abre && d.fecha ? d.abre + " às " + d.fecha : "Informe os horários")
        : "Fechado o dia todo") + "</div></div>" +
      '<div class="chave-dia"><span class="rotulo">' + (aberto ? "Aberto" : "Fechado") + "</span>" +
      '<button type="button" class="chave' + (aberto ? " ligada" : "") + '" data-dia-chave="' + d.dia +
      '" role="switch" aria-checked="' + aberto + '" aria-label="' + DIAS_SEMANA[d.dia] + '"></button></div>' +
      "</div>" +
      (aberto
        ? '<div class="horas">' +
        '<div><label for="abre-' + d.dia + '">Abre às</label>' +
        '<input type="time" id="abre-' + d.dia + '" data-hora="abre" data-dia="' + d.dia + '" value="' + esc(d.abre) + '"></div>' +
        '<div><label for="fecha-' + d.dia + '">Fecha às</label>' +
        '<input type="time" id="fecha-' + d.dia + '" data-hora="fecha" data-dia="' + d.dia + '" value="' + esc(d.fecha) + '"></div>' +
        "</div>" +
        (fechaNoDiaSeguinte(d) ? '<p class="aviso-madrugada">Fecha no dia seguinte.</p>' : "")
        : "") +
      "</div>";
  }

  function marcarSujo() {
    estado.horariosSujo = true;
    const selo = $("#selo-sujo");
    if (selo) selo.hidden = false;
  }

  /* Troca apenas o card daquele dia — o resto da tela não é redesenhado. */
  function redesenharDia(n) {
    const alvo = $("#dia-" + n);
    if (!alvo) return;
    const novo = document.createElement("div");
    novo.innerHTML = cartaoDia(estado.horarios[n]);
    alvo.replaceWith(novo.firstChild);
  }

  function alternarDia(n) {
    const d = estado.horarios[n];
    d.fechado = !d.fechado;
    if (!d.fechado && !d.abre && !d.fecha) {      // sugestão inicial, editável
      d.abre = HORA_PADRAO.abre;
      d.fecha = HORA_PADRAO.fecha;
    }
    if (d.fechado) { d.abre = ""; d.fecha = ""; } // fechado: sem horários
    redesenharDia(n);
    marcarSujo();
  }

  async function salvarHorarios() {
    if (estado.salvando) return;
    const erro = $("#erro-horarios");
    const mostrar = (m) => { erro.textContent = m; erro.hidden = false; };
    erro.hidden = true;
    $$(".horas input").forEach((i) => i.classList.remove("invalido"));

    /* dia aberto precisa dos dois horários; iguais é ambíguo.
       abertura maior que o fechamento é permitido (vira madrugada). */
    for (let i = 0; i < estado.horarios.length; i++) {
      const d = estado.horarios[i];
      if (d.fechado) continue;
      if (!d.abre || !d.fecha) {
        const campo = $("#" + (d.abre ? "fecha-" : "abre-") + d.dia);
        if (campo) { campo.classList.add("invalido"); campo.focus(); }
        return mostrar("Informe um horário de abertura e fechamento para " + DIAS_SEMANA[d.dia].toLowerCase() + ".");
      }
      if (d.abre === d.fecha) {
        const campo = $("#fecha-" + d.dia);
        if (campo) { campo.classList.add("invalido"); campo.focus(); }
        return mostrar("O horário de abertura e de fechamento de " + DIAS_SEMANA[d.dia].toLowerCase() + " não podem ser iguais.");
      }
    }

    const btn = $("#salvar-horarios");
    const rotulo = btn.textContent;
    estado.salvando = true;
    btn.disabled = true; btn.textContent = "Salvando...";
    try {
      /* upsert pela chave (business_id, day_of_week): atualiza o que existe
         e cria o que faltar — nada é apagado e recriado. */
      const linhas = estado.horarios.map(function (d) {
        return {
          business_id: estado.empresa.id,
          day_of_week: d.dia,
          is_closed: !!d.fechado,
          opens_at: d.fechado ? null : d.abre,
          closes_at: d.fechado ? null : d.fecha
        };
      });
      const r1 = await sb.from("business_hours")
        .upsert(linhas, { onConflict: "business_id,day_of_week" }).select();
      if (r1.error) throw r1.error;

      const r2 = await sb.from("business_hours_settings").upsert({
        business_id: estado.empresa.id,
        timezone: estado.horariosCfg.timezone || "America/Sao_Paulo",
        accept_orders_when_closed: estado.horariosCfg.accept_orders_when_closed !== false
      }, { onConflict: "business_id" }).select();
      if (r2.error) throw r2.error;
      if (!r2.data || !r2.data.length) throw new Error("Nenhuma linha foi gravada — verifique suas permissões.");

      estado.horariosCfg = r2.data[0];
      estado.horariosSujo = false;
      const selo = $("#selo-sujo");
      if (selo) selo.hidden = true;
      toast("Horários atualizados com sucesso.");
    } catch (e) {
      console.error("[admin]", e);
      mostrar("Não foi possível salvar os horários. Tente novamente.");
    } finally {
      estado.salvando = false;
      btn.disabled = false; btn.textContent = rotulo;
    }
  }

  /* ---------- 12. CONFIGURAÇÕES ------------------------------------- */

  /* Normalização e validação vêm de ../whatsapp.js — o MESMO arquivo que o
     site público usa, para os dois nunca discordarem sobre o que é válido. */
  const normalizarWhats = (v) => (window.Whats && window.Whats.normalizar)
    ? window.Whats.normalizar(v)
    : { ok: false, numero: "", exibicao: "", motivo: "whatsapp.js não carregou." };

  /* ---- normalizações desta tela -------------------------------------
     Campo vazio sempre vira null no banco (nunca string vazia).
     Validação só acontece quando HÁ valor: nada aqui é obrigatório,
     porque outras empresas podem não querer mostrar endereço.
     ------------------------------------------------------------------ */
  const LIMITE_DESC = 160;

  const textoOuNulo = (v) => {
    const s = String(v == null ? "" : v).trim().replace(/\s+/g, " ");
    return s ? s : null;
  };

  /* Aceita @usuario, a URL inteira, com ou sem https, com barra final,
     com ?hl=pt — e guarda só "usuario". */
  function normalizarInstagram(valor) {
    let s = String(valor == null ? "" : valor).trim();
    if (!s) return { ok: true, valor: null, motivo: "" };

    s = s.split(/[?#]/)[0];                                   // fora query e âncora
    s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    s = s.replace(/^(?:instagram\.com|instagr\.am)\//i, "");  // fora o domínio
    s = s.replace(/^@+/, "").replace(/\/+$/, "");             // fora @ e barras
    s = s.replace(/\s+/g, "");                                // fora espaços

    if (!s) {
      return {
        ok: false, valor: null,
        motivo: "Não consegui achar o nome de usuário nesse endereço."
      };
    }
    if (!/^[A-Za-z0-9._]{1,30}$/.test(s)) {
      return {
        ok: false, valor: null,
        motivo: "O usuário do Instagram só pode ter letras, números, ponto e sublinhado."
      };
    }
    return { ok: true, valor: s, motivo: "" };
  }

  /* 18603550 ou 18603-550 -> guarda e mostra 18603-550 */
  function normalizarCep(valor) {
    const s = String(valor == null ? "" : valor).trim();
    if (!s) return { ok: true, valor: null, motivo: "" };
    const d = s.replace(/\D/g, "");
    if (d.length !== 8) {
      return {
        ok: false, valor: null,
        motivo: "O CEP precisa ter 8 dígitos. Exemplo: 18603-550."
      };
    }
    return { ok: true, valor: d.slice(0, 5) + "-" + d.slice(5), motivo: "" };
  }

  const UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB",
    "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];

  /* Descrição do formulário: id do campo, coluna no banco e como tratar.
     A mesma lista carrega, valida e salva — sem repetir nome de coluna. */
  const CAMPOS_PERFIL = [
    { id: "cfg-desc", col: "short_description", trata: textoOuNulo },
    { id: "cfg-insta", col: "instagram", norm: normalizarInstagram },
    { id: "cfg-rua", col: "address_street", trata: textoOuNulo },
    { id: "cfg-num", col: "address_number", trata: textoOuNulo },
    { id: "cfg-bairro", col: "address_neighborhood", trata: textoOuNulo },
    { id: "cfg-compl", col: "address_complement", trata: textoOuNulo },
    { id: "cfg-cidade", col: "address_city", trata: textoOuNulo },
    { id: "cfg-uf", col: "address_state", trata: textoOuNulo },
    { id: "cfg-cep", col: "address_postal_code", norm: normalizarCep }
  ];

  /* ---- identidade visual: logo e favicon -----------------------------
     Bucket business-assets, caminhos FIXOS por empresa:
         <business_id>/logo.webp
         <business_id>/favicon.png
     Caminho fixo + upsert significa que trocar a imagem sobrescreve o
     arquivo: nunca aparece logo-1, logo-2, e nada fica acumulado.
     O banco guarda só o caminho — a URL pública é montada na hora.
     ------------------------------------------------------------------ */
  const MARCA = {
    logo: {
      col: "logo_path", arquivo: "logo.webp", tipo: "image/webp",
      titulo: "Logo da empresa", vazio: "Nenhuma logo cadastrada",
      enviar: "Enviar logo", trocar: "Trocar logo", remover: "Remover logo",
      artigo: "a logo",
      dica: "PNG, JPG ou WebP. Reduzimos para 1200 px no maior lado e convertemos para WebP, mantendo o fundo transparente."
    },
    favicon: {
      col: "favicon_path", arquivo: "favicon.png", tipo: "image/png",
      titulo: "Favicon", vazio: "Nenhum favicon cadastrado",
      enviar: "Enviar favicon", trocar: "Trocar favicon", remover: "Remover favicon",
      artigo: "o favicon",
      dica: "PNG, JPG ou WebP. Viram um quadrado de 512×512 com a imagem centralizada, sem distorcer, e a sobra fica transparente."
    }
  };

  const caminhoMarca = (qual) => estado.empresa.id + "/" + MARCA[qual].arquivo;

  /* URL pública para a PRÉVIA. O "?v=" quebra o cache do navegador — o
     caminho no banco é sempre sem parâmetro nenhum. */
  function urlMarca(caminho, versao) {
    if (!caminho) return "";
    const r = sb.storage.from(BUCKET_MARCA).getPublicUrl(caminho);
    const url = (r && r.data && r.data.publicUrl) || "";
    return url ? url + "?v=" + (versao || 0) : "";
  }

  function carregarImagem(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("arquivo não é uma imagem legível")); };
      img.src = url;
    });
  }

  const paraBlob = (canvas, tipo, q) => new Promise(function (resolve, reject) {
    canvas.toBlob(function (b) {
      if (b) resolve(b); else reject(new Error("não foi possível converter a imagem"));
    }, tipo, q);
  });

  /* LOGO — proporção preservada, no máximo 1200 px no maior lado e NUNCA
     ampliada (escala limitada a 1). O canvas nasce transparente e nada é
     pintado no fundo, então PNG/WebP com transparência continuam
     transparentes; WebP guarda o canal alfa. */
  async function processarLogo(file) {
    const img = await carregarImagem(file);
    const escala = Math.min(1, LOGO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * escala));
    c.height = Math.max(1, Math.round(img.naturalHeight * escala));
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return paraBlob(c, "image/webp", 0.92);
  }

  /* FAVICON — quadrado de 512. A imagem é encaixada INTEIRA (contain),
     centralizada, sem esticar; a sobra fica transparente. Aqui a escala
     pode passar de 1: um favicon precisa de 512 px reais, senão o ícone
     apareceria minúsculo dentro de um quadrado quase vazio. PNG por
     causa da transparência. */
  async function processarFavicon(file) {
    const img = await carregarImagem(file);
    const c = document.createElement("canvas");
    c.width = FAVICON_LADO;
    c.height = FAVICON_LADO;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    const escala = Math.min(FAVICON_LADO / img.naturalWidth, FAVICON_LADO / img.naturalHeight);
    const l = Math.max(1, Math.round(img.naturalWidth * escala));
    const a = Math.max(1, Math.round(img.naturalHeight * escala));
    ctx.drawImage(img, Math.round((FAVICON_LADO - l) / 2), Math.round((FAVICON_LADO - a) / 2), l, a);
    return paraBlob(c, "image/png");
  }

  /* upsert: true sobrescreve o arquivo do mesmo caminho */
  async function enviarMarca(qual, file) {
    const cfg = MARCA[qual];
    const blob = await (qual === "logo" ? processarLogo(file) : processarFavicon(file));
    const caminho = caminhoMarca(qual);
    const r = await sb.storage.from(BUCKET_MARCA).upload(caminho, blob, {
      contentType: cfg.tipo, cacheControl: "3600", upsert: true
    });
    if (r.error) throw r.error;
    return caminho;
  }

  /* O Supabase não reclama de remover um objeto que já não existe, então
     um caminho inválido no banco também consegue ser limpo. */
  async function removerMarca(qual) {
    const caminho = valorAtual(MARCA[qual].col) || caminhoMarca(qual);
    const r = await sb.storage.from(BUCKET_MARCA).remove([caminho]);
    if (r.error) throw r.error;
  }

  function escolherMarca(qual, file) {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      toast("Use uma imagem PNG, JPG ou WebP", "erro"); return;
    }
    if (file.size > LIMITE_MARCA) {
      toast("Imagem muito grande (máx. 5 MB)", "erro"); return;
    }
    const leitor = new FileReader();
    leitor.onerror = function () { toast("Não foi possível ler o arquivo.", "erro"); };
    leitor.onload = function () {
      const est = estado.marca[qual];
      est.arquivo = file;
      est.previa = leitor.result;     // prévia local: nada subiu ainda
      est.remover = false;
      marcarCfgSujo();
      renderAreaMarca(qual);
    };
    leitor.readAsDataURL(file);
  }

  function pedirRemocaoMarca(qual) {
    const cfg = MARCA[qual];
    confirmar("Remover " + cfg.artigo + "?",
      "O arquivo sai do Storage quando você clicar em Salvar configurações.",
      "Remover", function () {
        const est = estado.marca[qual];
        est.remover = true; est.arquivo = null; est.previa = "";
        marcarCfgSujo();
        renderAreaMarca(qual);
      });
  }

  function desfazerMarca(qual) {
    const est = estado.marca[qual];
    est.arquivo = null; est.previa = ""; est.remover = false;
    renderAreaMarca(qual);
  }

  /* Redesenha só a área daquele item — o resto do formulário, com o que
     já foi digitado, fica intacto. */
  function renderAreaMarca(qual) {
    const alvo = $("#marca-" + qual);
    if (alvo) alvo.innerHTML = conteudoMarca(qual);
  }

  function conteudoMarca(qual) {
    const cfg = MARCA[qual];
    const est = estado.marca[qual];
    const salvo = valorAtual(cfg.col);
    const pendente = !!est.arquivo || est.remover;
    const mostrar = est.remover ? "" : (est.previa || (salvo ? urlMarca(salvo, est.versao) : ""));

    return '<div class="marca-previa ' + qual + (mostrar ? "" : " sem-imagem") + '">' +
      (mostrar
        ? '<img src="' + esc(mostrar) + '" alt="' + esc(cfg.titulo) + '">'
        : '<span class="marca-vazio">' + esc(cfg.vazio) + "</span>") +
      "</div>" +
      '<div class="marca-acoes">' +
      '<input type="file" id="arq-' + qual + '" data-marca="' + qual +
      '" accept="image/png,image/jpeg,image/webp" hidden>' +
      '<button type="button" class="btn btn-secundario" data-marca-escolher="' + qual + '">' +
      esc(mostrar ? cfg.trocar : cfg.enviar) + "</button>" +
      (mostrar && salvo && !est.arquivo
        ? '<button type="button" class="btn btn-fantasma" data-marca-remover="' + qual + '">' +
        esc(cfg.remover) + "</button>"
        : "") +
      (pendente
        ? '<button type="button" class="btn btn-fantasma" data-marca-desfazer="' + qual + '">Desfazer</button>'
        : "") +
      '<p class="dica">' +
      (est.remover ? '<b class="marca-pendente">Será removido ao salvar.</b>'
        : est.arquivo ? '<b class="marca-pendente">Nova imagem escolhida — clique em Salvar configurações.</b>'
          : esc(cfg.dica)) +
      "</p>" +
      "</div>";
  }

  /* A linha de businesses já veio no login — nenhuma consulta nova aqui. */
  const temColuna = (col) => !!estado.empresa && (col in estado.empresa);
  const valorAtual = (col) => (temColuna(col) && estado.empresa[col] != null)
    ? String(estado.empresa[col]) : "";
  const temPerfil = () => CAMPOS_PERFIL.some((c) => temColuna(c.col));

  /* ---- tela ---------------------------------------------------------- */
  function renderConfig() {
    const e = estado.empresa;
    const guardado = estado.campoWhats ? (e[estado.campoWhats] || "") : "";
    const atual = normalizarWhats(guardado);
    const desc = valorAtual("short_description");
    const insta = valorAtual("instagram");

    const campo = (id, rotulo, extra, dica) =>
      '<div class="campo"><label for="' + id + '">' + rotulo + "</label>" +
      '<input id="' + id + '" ' + extra + ' value="' + esc(valorAtual(campoCol(id))) + '">' +
      (dica ? '<p class="dica">' + dica + "</p>" : "") + "</div>";

    $("#conteudo").innerHTML =
      '<div class="cabeca-pagina"><div><h2>Configurações</h2>' +
      "<p>Dados da empresa</p></div></div>" +
      '<div id="form-cfg">' +

      /* ---------- bloco 1: informações da empresa ---------- */
      '<div class="painel-caixa"><h3>Informações da empresa</h3>' +
      '<div class="campo"><label for="cfg-nome">Nome da empresa</label>' +
      '<input id="cfg-nome" maxlength="80" value="' + esc(e[estado.campoNome] || "") + '">' +
      '<p class="dica">Aparece no cabeçalho, na seção sobre, no rodapé e na mensagem do pedido.</p></div>' +

      '<div class="campo"><label for="cfg-whats">WhatsApp que recebe os pedidos</label>' +
      '<input id="cfg-whats" inputmode="tel" autocomplete="tel" placeholder="(14) 99798-2903"' +
      (estado.campoWhats ? "" : " disabled") +
      ' value="' + esc(atual.ok ? atual.exibicao : guardado) + '">' +
      '<p class="dica" id="dica-whats">' + esc(textoWhats(atual, guardado)) + "</p></div>" +

      (estado.campoWhats
        ? '<p class="aviso-info">Pode digitar como preferir — <b>(14) 99798-2903</b>, <b>+55 14 99798-2903</b> ou só os números. ' +
        "O painel guarda no formato do WhatsApp e o cardápio passa a enviar os pedidos para este número na hora, sem publicar o site de novo.</p>"
        : '<p class="aviso-info">A tabela <b>businesses</b> ainda não tem uma coluna de WhatsApp. Crie a coluna <code>whatsapp</code> no Supabase para liberar este campo.</p>') +

      (temColuna("short_description")
        ? '<div class="campo"><label for="cfg-desc">Descrição curta <span class="opcional">opcional</span></label>' +
        '<textarea id="cfg-desc" maxlength="' + LIMITE_DESC + '" rows="3" ' +
        'placeholder="Conte em poucas palavras o que torna seu estabelecimento especial.">' +
        esc(desc) + "</textarea>" +
        '<p class="dica contador"><span id="conta-desc">' + desc.length + " / " + LIMITE_DESC +
        "</span></p></div>"
        : "") +
      "</div>" +

      /* ---------- bloco 2: identidade visual ---------- */
      ((temColuna("logo_path") || temColuna("favicon_path"))
        ? '<div class="painel-caixa"><h3>Identidade visual</h3>' +
        (temColuna("logo_path")
          ? '<div class="campo"><label>' + MARCA.logo.titulo + "</label>" +
          '<div class="marca-area" id="marca-logo">' + conteudoMarca("logo") + "</div></div>"
          : "") +
        (temColuna("favicon_path")
          ? '<div class="campo"><label>' + MARCA.favicon.titulo +
          ' <span class="opcional">ícone da aba</span></label>' +
          '<div class="marca-area" id="marca-favicon">' + conteudoMarca("favicon") + "</div></div>"
          : "") +
        '<p class="aviso-info">As imagens são enviadas quando você clica em <b>Salvar configurações</b>. ' +
        "Elas ainda não aparecem no site — isso entra na próxima etapa.</p>" +
        "</div>"
        : "") +

      /* ---------- bloco 3: redes sociais ---------- */
      (temColuna("instagram")
        ? '<div class="painel-caixa"><h3>Redes sociais</h3>' +
        '<div class="campo"><label for="cfg-insta">Instagram <span class="opcional">opcional</span></label>' +
        '<div class="campo-arroba"><span aria-hidden="true">@</span>' +
        '<input id="cfg-insta" autocapitalize="none" autocorrect="off" spellcheck="false" ' +
        'placeholder="seunegocio" value="' + esc(insta) + '"></div>' +
        '<p class="dica" id="dica-insta">' + esc(textoInsta(normalizarInstagram(insta), insta)) + "</p></div>" +
        '<p class="aviso-info">Pode colar o endereço inteiro do perfil — ' +
        "<b>instagram.com/seunegocio</b> — que o painel guarda só o nome de usuário.</p>" +
        "</div>"
        : "") +

      /* ---------- bloco 4: endereço ---------- */
      (temColuna("address_street")
        ? '<div class="painel-caixa"><h3>Endereço do estabelecimento</h3>' +
        '<div class="linha-rua">' +
        campo("cfg-rua", "Rua / Avenida", 'maxlength="120" autocomplete="address-line1" placeholder="Ex.: Rua das Palmeiras"') +
        campo("cfg-num", "Número", 'maxlength="20" placeholder="123, 123-A ou s/n"') +
        "</div>" +
        '<div class="duas">' +
        campo("cfg-bairro", "Bairro", 'maxlength="80" placeholder="Ex.: Centro"') +
        campo("cfg-compl", 'Complemento <span class="opcional">opcional</span>', 'maxlength="80" placeholder="Sala, bloco, ponto de referência"') +
        "</div>" +
        '<div class="linha-cidade">' +
        campo("cfg-cidade", "Cidade", 'maxlength="80" placeholder="Ex.: Botucatu"') +
        '<div class="campo"><label for="cfg-uf">Estado</label>' +
        '<select id="cfg-uf"><option value="">UF</option>' +
        UFS.map(function (uf) {
          return '<option value="' + uf + '"' +
            (valorAtual("address_state").toUpperCase() === uf ? " selected" : "") + ">" + uf + "</option>";
        }).join("") + "</select></div>" +
        campo("cfg-cep", "CEP", 'inputmode="numeric" maxlength="9" autocomplete="postal-code" placeholder="18603-550"') +
        "</div>" +
        '<p class="aviso-info">Todos os campos de endereço são opcionais nesta etapa — ' +
        "preencha só o que fizer sentido para a sua casa.</p>" +
        "</div>"
        : "") +

      (temPerfil() ? ""
        : '<p class="aviso-info">A tabela <b>businesses</b> ainda não tem as colunas de perfil. ' +
        "Rode o <code>business-profile-schema.sql</code> no Supabase para liberar estes campos.</p>") +

      '<p class="aviso-form" id="erro-cfg" hidden></p>' +
      '<div class="barra-salvar">' +
      '<span class="selo-sujo" id="selo-sujo-cfg"' + (estado.cfgSujo ? "" : " hidden") + ">Alterações não salvas</span>" +
      '<button type="button" class="btn btn-principal" id="salvar-cfg">Salvar configurações</button>' +
      "</div>" +
      "</div>";

    ligarFormConfig();
    $("#salvar-cfg").onclick = salvarConfig;
  }

  const campoCol = (id) => (CAMPOS_PERFIL.find((c) => c.id === id) || {}).col || "";

  const textoWhats = (r, bruto) =>
    !String(bruto || "").trim() ? "Sem número cadastrado — o cardápio não consegue enviar pedidos."
      : r.ok ? "Será gravado como " + r.numero + "."
        : r.motivo;

  const textoInsta = (r, bruto) =>
    !String(bruto || "").trim() ? "Deixe em branco se a casa não tem Instagram."
      : r.ok ? "Será gravado como " + r.valor + "."
        : r.motivo;

  /* Os eventos são ligados ao #form-cfg, que é recriado a cada render —
     os ouvintes vão embora junto com o nó antigo, sem acumular. */
  function ligarFormConfig() {
    const form = $("#form-cfg");
    if (!form) return;

    form.addEventListener("input", function (ev) {
      const el = ev.target;
      marcarCfgSujo();

      if (el.id === "cfg-whats") {
        const r = normalizarWhats(el.value);
        $("#dica-whats").textContent = textoWhats(r, el.value);
        el.classList.toggle("invalido", !!el.value.trim() && !r.ok);
      } else if (el.id === "cfg-insta") {
        const r = normalizarInstagram(el.value);
        $("#dica-insta").textContent = textoInsta(r, el.value);
        el.classList.toggle("invalido", !!el.value.trim() && !r.ok);
      } else if (el.id === "cfg-desc") {
        const conta = $("#conta-desc");
        conta.textContent = el.value.length + " / " + LIMITE_DESC;
        conta.classList.toggle("no-limite", el.value.length >= LIMITE_DESC);
      } else if (el.id === "cfg-cep") {
        /* máscara enquanto digita, sem atrapalhar quem apaga */
        const d = el.value.replace(/\D/g, "").slice(0, 8);
        const novo = d.length > 5 ? d.slice(0, 5) + "-" + d.slice(5) : d;
        if (novo !== el.value) el.value = novo;
        el.classList.remove("invalido");
      }
    });

    form.addEventListener("change", function (ev) {
      const arq = ev.target.closest("input[type=file][data-marca]");
      if (arq) {
        escolherMarca(arq.dataset.marca, arq.files && arq.files[0]);
        arq.value = "";              // permite reescolher o MESMO arquivo depois
        return;
      }
      marcarCfgSujo();
    });

    form.addEventListener("click", function (ev) {
      const abrir = ev.target.closest("[data-marca-escolher]");
      if (abrir) {
        const campo = $("#arq-" + abrir.dataset.marcaEscolher);
        if (campo) campo.click();
        return;
      }
      const tirar = ev.target.closest("[data-marca-remover]");
      if (tirar) { pedirRemocaoMarca(tirar.dataset.marcaRemover); return; }

      const voltar = ev.target.closest("[data-marca-desfazer]");
      if (voltar) { desfazerMarca(voltar.dataset.marcaDesfazer); return; }
    });
  }

  function marcarCfgSujo() {
    estado.cfgSujo = true;
    const selo = $("#selo-sujo-cfg");
    if (selo) selo.hidden = false;
  }

  /* ---- salvar: UM update com a linha inteira -------------------------- */
  async function salvarConfig() {
    if (estado.salvando) return;                       // trava o clique duplo
    const btn = $("#salvar-cfg"), erro = $("#erro-cfg");
    const mostrar = (m, foco) => {
      erro.textContent = m; erro.hidden = false;
      if (foco) { foco.classList.add("invalido"); foco.focus(); foco.scrollIntoView({ block: "center", behavior: "smooth" }); }
      return false;
    };
    erro.hidden = true;
    $$("#form-cfg .invalido").forEach((el) => el.classList.remove("invalido"));

    const nome = $("#cfg-nome").value.trim();
    if (!nome) return mostrar("O nome da empresa não pode ficar vazio.", $("#cfg-nome"));

    const dados = {};
    dados[estado.campoNome] = nome;

    /* WhatsApp: normalização inalterada — só dígitos, com o código do país. */
    if (estado.campoWhats) {
      const r = normalizarWhats($("#cfg-whats").value);
      if (!r.ok) return mostrar(r.motivo, $("#cfg-whats"));
      dados[estado.campoWhats] = r.numero;
    }

    /* Perfil: nada é obrigatório. Vazio vira null; só validamos o que
       tiver valor. Colunas que não existem no banco não entram no update. */
    for (let i = 0; i < CAMPOS_PERFIL.length; i++) {
      const c = CAMPOS_PERFIL[i];
      const el = $("#" + c.id);
      if (!el || !temColuna(c.col)) continue;
      if (c.norm) {
        const r = c.norm(el.value);
        if (!r.ok) return mostrar(r.motivo, el);
        dados[c.col] = r.valor;
      } else {
        dados[c.col] = c.trata(el.value);
      }
    }

    const rotulo = btn.textContent;
    estado.salvando = true;
    ocupado(btn, true);
    btn.textContent = "Salvando...";

    let fase = "imagens";
    const enviados = [];      // o que subiu NESTA rodada, para poder desfazer
    try {
      /* 1. STORAGE PRIMEIRO. O caminho só entra no update depois que o
            objeto existe de verdade. Se algo aqui falhar, o banco nem
            chega a ser tocado e a imagem anterior continua valendo. */
      const itens = ["logo", "favicon"];
      for (let k = 0; k < itens.length; k++) {
        const qual = itens[k], cfg = MARCA[qual], est = estado.marca[qual];
        if (!temColuna(cfg.col)) continue;

        if (est.arquivo) {
          const tinhaAntes = !!valorAtual(cfg.col);
          dados[cfg.col] = await enviarMarca(qual, est.arquivo);
          enviados.push({ qual: qual, tinhaAntes: tinhaAntes });
        } else if (est.remover) {
          await removerMarca(qual);
          dados[cfg.col] = null;
        }
      }

      /* 2. Uma única requisição ao banco, filtrada pela empresa do
            usuário. A RLS de businesses é quem garante que seja a dele. */
      fase = "banco";
      const r = await sb.from("businesses").update(dados).eq("id", estado.empresa.id).select();
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw new Error("Nenhuma linha foi gravada — verifique suas permissões.");

      estado.empresa = r.data[0];
      estado.cfgSujo = false;
      /* nova versão = prévia sai do cache do navegador; o banco continua
         guardando o caminho puro, sem "?v=" */
      const agora = Date.now();
      estado.marca = {
        logo: { arquivo: null, previa: "", remover: false, versao: agora },
        favicon: { arquivo: null, previa: "", remover: false, versao: agora }
      };
      $("#topo-empresa").textContent = estado.empresa[estado.campoNome] || "Painel";
      if (estado.aba === "config") renderConfig();     // mostra os valores já normalizados
      toast("Configurações salvas com sucesso.");
    } catch (e2) {
      console.error("[admin]", e2);
      if (fase === "imagens") {
        mostrar("Não foi possível enviar a imagem. Tente novamente.");
      } else {
        await desfazerEnviados(enviados);
        mostrar("Não foi possível salvar as configurações. Tente novamente.");
      }
    } finally {
      estado.salvando = false;
      ocupado(btn, false);
      if (btn.isConnected) btn.textContent = rotulo;
    }
  }

  /* Upload passou, banco falhou. Como o caminho é FIXO, há dois casos:

     · não havia imagem antes -> o banco continua null e sobrou um objeto
       órfão no Storage. Apagamos, e tudo volta a ficar coerente.

     · já havia imagem -> o banco continua apontando para o MESMO caminho,
       que existe e agora tem a imagem nova. Não há caminho inválido, e
       apagar o objeto é que criaria um (banco apontando para o vazio).
       Então o arquivo fica: basta o usuário salvar de novo.

     Em nenhum dos dois casos o banco fica apontando para um objeto que
     não existe — que é a inconsistência que realmente machuca. */
  async function desfazerEnviados(enviados) {
    for (let i = 0; i < enviados.length; i++) {
      if (enviados[i].tinhaAntes) continue;
      try { await removerMarca(enviados[i].qual); }
      catch (e) { console.warn("[admin] não foi possível desfazer o upload de " + enviados[i].qual, e); }
    }
  }

  /* ---------- 13. DOMÍNIOS -------------------------------------------
     Endereços que abrem o cardápio desta empresa. O site público lê essa
     mesma tabela pela RPC resolve_business_by_domain().

     Três coisas para ter em mente ao mexer aqui:

     · A NORMALIZAÇÃO OFICIAL É DO BANCO. Um trigger BEFORE INSERT/UPDATE
       roda normalize_business_domain(), que tira esquema, caminho,
       porta, usuário, "www." e ponto final. O que existe aqui no
       frontend é limpeza visual — o valor que a tela mostra é sempre o
       que VOLTOU do banco, nunca o que foi digitado.

     · `domain` é único no projeto inteiro. Um domínio já usado por outra
       empresa é invisível para este usuário (RLS), então o erro não pode
       dizer "está na sua lista": diz só que já existe no sistema.

     · Duas regras do banco mandam no comportamento da tela: no máximo um
       is_primary por empresa (índice único parcial) e principal precisa
       estar ativo (check). A ordem das operações abaixo existe por causa
       delas.

     Cadastrar aqui NÃO configura DNS nem adiciona o domínio à
     hospedagem — e também não comprova propriedade. A verificação de
     propriedade ainda não existe; quando existir, entra como mais uma
     etiqueta em etiquetasDominio() e um campo na linha, sem mudar o
     resto desta seção.
     ------------------------------------------------------------------ */
  const SUFIXO_HOSPEDAGEM = ".vercel.app";
  const AVISO_DNS = "O domínio também precisa estar configurado na hospedagem e no DNS para funcionar.";
  const AVISO_DESATIVAR_PRINCIPAL = "Defina outro domínio como principal antes de desativar este endereço.";

  /* Limpeza APENAS visual, para o usuário ver o que vai gravar. Quem
     manda é normalize_business_domain(), no banco. */
  function limparDominio(valor) {
    let d = String(valor == null ? "" : valor).trim().toLowerCase();
    d = d.replace(/\s/g, "");
    if (!d) return "";
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");   // http:// https:// ...
    d = d.split("/")[0].split("?")[0].split("#")[0];
    d = d.replace(/^[^@]*@/, "");                    // usuario:senha@
    d = d.replace(/:[0-9]+$/, "");                   // porta
    d = d.replace(/\.+$/, "");
    d = d.replace(/^www\./, "");
    d = d.replace(/\.+$/, "");
    return d;
  }

  const ehHospedagem = (d) => String(d || "").toLowerCase().slice(-SUFIXO_HOSPEDAGEM.length) === SUFIXO_HOSPEDAGEM;

  /* Erros do Postgres viram frase de gente. */
  function erroDominio(e) {
    const m = (e && (e.message || e.error_description)) || "";
    const cod = (e && e.code) || "";
    if (cod === "23505" || /duplicate key|already exists|unique constraint|unique index/i.test(m)) {
      if (/um_primario|is_primary/i.test(m)) {
        return "Já existe um domínio principal. Recarregue a página e tente de novo.";
      }
      return "Este domínio já está cadastrado no sistema.";
    }
    if (cod === "23514" || /check constraint/i.test(m)) {
      if (/primario_ativo/i.test(m)) return "O domínio principal precisa estar ativo.";
      return "Endereço inválido. Use algo como minhaempresa.com.br.";
    }
    if (cod === "23502" || /null value in column/i.test(m)) {
      return "Informe um endereço válido, como minhaempresa.com.br.";
    }
    return mensagemErro(e);
  }

  /* Principal primeiro, depois os mais antigos. */
  function ordenarDominios(linhas) {
    return (linhas || []).slice().sort(function (a, b) {
      const pa = a.is_primary === true ? 0 : 1, pb = b.is_primary === true ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return String(a.created_at || "").localeCompare(String(b.created_at || ""));
    });
  }

  /* A empresa vem SEMPRE de estado.empresa.id (descoberto em
     business_members). Nada aqui aceita business_id de campo, de URL ou
     de qualquer coisa que o usuário digite. */
  async function carregarDominios() {
    const r = await sb.from("business_domains").select("*")
      .eq("business_id", estado.empresa.id)
      .order("created_at", { ascending: true });
    if (r.error) throw r.error;
    estado.dominios = ordenarDominios(r.data || []);
    estado.dominiosCarregados = true;
  }

  /* Depois de QUALQUER escrita: a lista na tela é sempre a do banco,
     nunca um palpite local. */
  async function recarregarDominios() {
    await carregarDominios();
    if (estado.aba === "dominios") renderDominios();
  }

  function etiquetasDominio(d) {
    const ativo = d.active !== false;
    return '<div class="etiquetas">' +
      (d.is_primary === true ? '<span class="etiqueta dourada">Principal</span>' : "") +
      '<span class="etiqueta ' + (ativo ? "viva" : "apagada") + '">' + (ativo ? "Ativo" : "Inativo") + "</span>" +
      "</div>";
  }

  function linhaDominio(d) {
    const ativo = d.active !== false;
    const principal = d.is_primary === true;
    return '<div class="linha-dominio' + (ativo ? "" : " inativo") + '">' +
      '<span class="icone" aria-hidden="true">🌐</span>' +
      '<div class="dominio-texto"><div class="endereco">' + esc(d.domain) + "</div>" +
      etiquetasDominio(d) + "</div>" +
      '<span class="espaco"></span>' +
      '<div class="acoes">' +
      (principal ? "" :
        '<button type="button" class="btn btn-secundario" data-dom-principal="' + esc(d.id) + '">Tornar principal</button>') +
      '<button type="button" class="interruptor' + (ativo ? " ligado" : "") + '" data-dom-ativo="' + esc(d.id) + '">' +
      '<span class="bolinha"></span>' + (ativo ? "Ativo" : "Inativo") + "</button>" +
      (principal ? "" :
        '<button type="button" class="btn btn-fantasma" data-dom-excluir="' + esc(d.id) + '">Excluir</button>') +
      "</div>" +
      "</div>";
  }

  function renderDominios() {
    const cabeca = '<div class="cabeca-pagina"><div><h2>Domínios</h2>' +
      "<p>Gerencie os endereços que podem abrir seu cardápio.</p></div>" +
      '<button type="button" class="btn btn-principal" data-novo-dominio>+ Adicionar domínio</button></div>';

    if (!estado.dominiosCarregados) {
      $("#conteudo").innerHTML = cabeca +
        '<div class="painel-caixa"><div class="esq esq-linha" style="width:55%"></div>' +
        '<div class="esq esq-linha" style="width:30%"></div></div>' +
        '<div class="painel-caixa"><div class="esq esq-linha" style="width:45%"></div>' +
        '<div class="esq esq-linha" style="width:25%"></div></div>';
      carregarDominios()
        .then(function () { if (estado.aba === "dominios") renderDominios(); })
        .catch(function (e) {
          console.error("[admin]", e);
          $("#conteudo").innerHTML = cabeca +
            '<div class="vazio"><div class="icone">🌐</div><strong>Não foi possível carregar os domínios.</strong>' +
            "<p>" + esc(mensagemErro(e)) + "</p>" +
            '<button type="button" class="btn btn-principal" data-recarregar-dominios>Tentar novamente</button></div>';
        });
      return;
    }

    const lista = estado.dominios;
    $("#conteudo").innerHTML = cabeca +
      (lista.length
        ? '<div class="lista">' + lista.map(linhaDominio).join("") + "</div>"
        : '<div class="vazio"><div class="icone">🌐</div><strong>Nenhum domínio cadastrado.</strong>' +
        "<p>Enquanto não houver um endereço aqui, quem abrir o site vê " +
        "“Estabelecimento não encontrado”.</p>" +
        '<button type="button" class="btn btn-principal" data-novo-dominio>+ Adicionar domínio</button></div>') +
      '<div class="painel-caixa"><h3>Como isso funciona</h3>' +
      '<p class="dica">Quem abre um destes endereços cai no cardápio desta empresa. ' +
      "O <b>principal</b> é o endereço oficial da casa; os outros continuam funcionando normalmente " +
      "enquanto estiverem ativos — dá para manter o endereço da hospedagem e o domínio próprio ao mesmo tempo.</p>" +
      '<p class="dica" style="margin-top:8px">' + esc(AVISO_DNS) +
      " Cadastrar aqui não faz essa parte, e também não comprova que o domínio é seu.</p>" +
      "</div>";
  }

  /* ---------- adicionar ---------- */
  function abrirFormDominio() {
    const primeiro = estado.dominios.length === 0;
    abrirFolha("Adicionar domínio",
      '<div class="campo"><label for="dom-endereco">Domínio *</label>' +
      '<input id="dom-endereco" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
      'maxlength="253" placeholder="minhaempresa.com.br">' +
      '<p class="dica">Pode colar do jeito que estiver — <b>https://www.minhaempresa.com.br/</b> ' +
      "também serve. O sistema guarda só o endereço.</p></div>" +
      /* mesma chave das outras telas do painel, não um checkbox solto */
      '<div class="interruptor-linha"><div class="texto">Definir como domínio principal' +
      "<small>" + (primeiro
        ? "É o primeiro endereço da empresa — normalmente ele é o principal."
        : "O domínio principal de hoje passa a ser secundário, e continua ativo.") + "</small></div>" +
      '<button type="button" class="chave' + (primeiro ? " ligada" : "") + '" id="dom-principal" ' +
      'role="switch" aria-checked="' + (primeiro ? "true" : "false") +
      '" aria-label="Definir como domínio principal"></button></div>' +
      '<p class="aviso-info" id="dom-dns" hidden>' + esc(AVISO_DNS) + "</p>" +
      '<p class="aviso-form" id="erro-dom" hidden></p>',
      '<button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>' +
      '<button type="button" class="btn btn-principal" id="salvar-dom">Adicionar domínio</button>');

    const campo = $("#dom-endereco");
    const dns = $("#dom-dns");
    const chave = $("#dom-principal");
    let querPrincipal = primeiro;
    chave.onclick = function () {
      querPrincipal = !querPrincipal;
      chave.classList.toggle("ligada", querPrincipal);
      chave.setAttribute("aria-checked", String(querPrincipal));
    };
    const avaliarDns = function () {
      const d = limparDominio(campo.value);
      dns.hidden = !d || ehHospedagem(d);
    };
    campo.addEventListener("input", avaliarDns);
    campo.focus();

    $("#salvar-dom").onclick = async function () {
      const btn = this;
      const erro = $("#erro-dom");
      erro.hidden = true;
      const limpo = limparDominio(campo.value);
      if (!limpo) {
        erro.textContent = "Informe o endereço, como minhaempresa.com.br.";
        erro.hidden = false; return;
      }
      ocupado(btn, true);
      try {
        /* Entra sempre como secundário. Se for para ser o principal, a
           troca acontece depois, pelo mesmo caminho de sempre — assim o
           índice único do banco nunca vê dois principais ao mesmo tempo. */
        const r = await sb.from("business_domains").insert({
          business_id: estado.empresa.id,
          domain: limpo,
          is_primary: false,
          active: true
        }).select();
        if (r.error) throw r.error;
        if (!r.data || !r.data.length) throw new Error("Nenhuma linha foi gravada — verifique suas permissões.");

        const novo = r.data[0];      // já normalizado pelo banco
        estado.dominios = ordenarDominios(estado.dominios.concat([novo]));

        if (querPrincipal) {
          try {
            await definirPrincipal(novo.id);
          } catch (e2) {
            console.error("[admin]", e2);
            await recarregarDominios();
            fecharFolha();
            toast("Domínio adicionado, mas não foi possível torná-lo principal: " +
              (e2 && e2.message ? e2.message : erroDominio(e2)), "erro");
            return;
          }
        } else {
          await recarregarDominios();
        }

        fecharFolha();
        renderDominios();
        toast(ehHospedagem(novo.domain)
          ? "Domínio adicionado."
          : "Domínio adicionado. " + AVISO_DNS);
      } catch (e) {
        console.error("[admin]", e);
        erro.textContent = erroDominio(e);
        erro.hidden = false;
      } finally { ocupado(btn, false); }
    };
  }

  /* ---------- trocar o principal ----------
     O banco só aceita UM is_primary por empresa, então tirar do atual
     tem que vir antes de dar ao novo. Se o segundo passo falhar, o
     primeiro é desfeito: a empresa não pode acabar sem principal
     nenhum sem que ninguém perceba. */
  async function definirPrincipal(id) {
    const alvo = estado.dominios.find((x) => x.id === id);
    if (!alvo) throw new Error("Domínio não encontrado na lista.");
    const anterior = estado.dominios.find((x) => x.id !== id && x.is_primary === true) || null;

    if (anterior) {
      const r1 = await sb.from("business_domains").update({ is_primary: false })
        .eq("id", anterior.id).eq("business_id", estado.empresa.id).select();
      if (r1.error) throw r1.error;
      if (!r1.data || !r1.data.length) throw new Error("Nenhuma linha foi alterada — verifique suas permissões.");
    }

    /* O principal precisa estar ativo (regra do banco): se o escolhido
       estava inativo, ele é reativado aqui — e o usuário foi avisado
       disso antes de confirmar. */
    const r2 = await sb.from("business_domains").update({ is_primary: true, active: true })
      .eq("id", id).eq("business_id", estado.empresa.id).select();

    if (r2.error || !r2.data || !r2.data.length) {
      if (anterior) {
        const volta = await sb.from("business_domains").update({ is_primary: true })
          .eq("id", anterior.id).eq("business_id", estado.empresa.id).select();
        if (volta.error || !volta.data || !volta.data.length) {
          await recarregarDominios();
          const grave = new Error("A troca falhou e o domínio principal anterior não pôde ser restaurado. " +
            "Confira a lista e escolha o principal de novo.");
          throw grave;
        }
      }
      throw (r2.error || new Error("Nenhuma linha foi alterada — verifique suas permissões."));
    }

    await recarregarDominios();
  }

  function pedirPrincipal(id) {
    const d = estado.dominios.find((x) => x.id === id);
    if (!d) return;
    const anterior = estado.dominios.find((x) => x.id !== id && x.is_primary === true) || null;
    const inativo = d.active === false;

    confirmar("Tornar principal?",
      "O endereço " + d.domain + " passa a ser o domínio principal." +
      (anterior ? " " + anterior.domain + " vira secundário e continua ativo." : "") +
      (inativo ? " Ele também será reativado, porque o domínio principal precisa estar ativo." : ""),
      "Tornar principal",
      async function () {
        try {
          await definirPrincipal(id);
          toast("Domínio principal atualizado.");
        } catch (e) {
          console.error("[admin]", e);
          throw new Error(e && e.message && /restaurado|permissões|principal/.test(e.message)
            ? e.message : erroDominio(e));
        }
      });
  }

  /* ---------- ativar / desativar ---------- */
  async function alternarDominio(id, botao) {
    const d = estado.dominios.find((x) => x.id === id);
    if (!d) return;
    const ativo = d.active !== false;

    /* regra do banco: principal não pode ficar inativo */
    if (ativo && d.is_primary === true) {
      toast(AVISO_DESATIVAR_PRINCIPAL, "erro");
      return;
    }

    botao.disabled = true;
    const r = await sb.from("business_domains").update({ active: !ativo })
      .eq("id", id).eq("business_id", estado.empresa.id).select();
    botao.disabled = false;

    if (r.error || !r.data || !r.data.length) { toast(erroDominio(r.error), "erro"); return; }
    try { await recarregarDominios(); }
    catch (e) { d.active = !ativo; renderDominios(); }
    toast(ativo
      ? "Domínio desativado. Este endereço não abre mais o cardápio."
      : "Domínio ativado.");
  }

  /* ---------- excluir ---------- */
  function pedirExclusaoDominio(id) {
    const d = estado.dominios.find((x) => x.id === id);
    if (!d) return;

    if (d.is_primary === true) {
      abrirFolha("Não é possível remover",
        '<p style="color:var(--tinta-2)">O endereço <b>' + esc(d.domain) + "</b> é o domínio " +
        "<b>principal</b> da empresa.</p>" +
        '<p class="aviso-info">Defina outro domínio como principal antes de remover este endereço.</p>',
        '<button type="button" class="btn btn-secundario" data-fechar>Entendi</button>');
      return;
    }

    const unico = estado.dominios.length === 1;
    confirmar("Remover este domínio?",
      "Este endereço deixará de localizar o estabelecimento." +
      (unico
        ? " Ele é o ÚNICO endereço cadastrado: sem ele, nenhum endereço vai abrir o cardápio desta empresa, " +
        "e quem tentar verá “Estabelecimento não encontrado”."
        : ""),
      unico ? "Remover mesmo assim" : "Remover domínio",
      async function () {
        const r = await sb.from("business_domains").delete()
          .eq("id", id).eq("business_id", estado.empresa.id);
        if (r.error) throw new Error(erroDominio(r.error));
        await recarregarDominios();
        toast("Domínio removido.");
      });
  }

  /* ---------- EVENTOS GLOBAIS --------------------------------------- */
  function ligarEventos() {
    $("#form-login").addEventListener("submit", entrar);
    $("#ver-senha").addEventListener("click", function () {
      const i = $("#login-senha");
      const mostrando = i.type === "text";
      i.type = mostrando ? "password" : "text";
      this.textContent = mostrando ? "Mostrar" : "Ocultar";
      this.setAttribute("aria-label", mostrando ? "Mostrar senha" : "Ocultar senha");
    });
    $("#btn-sair").addEventListener("click", sair);

    /* primeiro acesso: mesmo comportamento do "Mostrar" do login */
    $("#form-senha").addEventListener("submit", criarSenha);
    $("#ver-nova-senha").addEventListener("click", function () {
      const i = $("#nova-senha");
      const mostrando = i.type === "text";
      i.type = mostrando ? "password" : "text";
      this.textContent = mostrando ? "Mostrar" : "Ocultar";
      this.setAttribute("aria-label", mostrando ? "Mostrar senha" : "Ocultar senha");
    });

    document.addEventListener("click", function (ev) {
      const aba = ev.target.closest("[data-aba]");
      if (aba) { irPara(aba.dataset.aba); return; }
      const ir = ev.target.closest("[data-aba-ir]");
      if (ir) { irPara(ir.dataset.abaIr); return; }
      if (ev.target.closest("[data-novo-produto]")) { abrirFormProduto(null); return; }
      if (ev.target.closest("[data-fechar]")) { fecharFolha(); return; }

      const tog = ev.target.closest("[data-toggle]");
      if (tog) { alternarDisponibilidade(tog.dataset.toggle, tog); return; }
      const ed = ev.target.closest("[data-editar]");
      if (ed) { abrirFormProduto(ed.dataset.editar); return; }
      const ex = ev.target.closest("[data-excluir]");
      if (ex) { pedirExclusao(ex.dataset.excluir); return; }

      const ca = ev.target.closest("[data-cat-ativa]");
      if (ca) { alternarCategoria(ca.dataset.catAtiva, ca); return; }
      const ce = ev.target.closest("[data-cat-editar]");
      if (ce) { abrirFormCategoria(ce.dataset.catEditar); return; }
      const cx = ev.target.closest("[data-cat-excluir]");
      if (cx) { pedirExclusaoCategoria(cx.dataset.catExcluir); return; }
      if (ev.target.closest("[data-recarregar-horarios]")) { estado.horariosCarregados = false; renderHorarios(); return; }
      const diaChave = ev.target.closest("[data-dia-chave]");
      if (diaChave) { alternarDia(Number(diaChave.dataset.diaChave)); return; }
      const chaveHor = ev.target.closest("[data-chave-horario]");
      if (chaveHor) {
        const cfg = estado.horariosCfg;
        cfg.accept_orders_when_closed = !(cfg.accept_orders_when_closed !== false);
        chaveHor.classList.toggle("ligada", cfg.accept_orders_when_closed);
        chaveHor.setAttribute("aria-checked", String(cfg.accept_orders_when_closed));
        const txt = $("#texto-fora-horario");
        if (txt) txt.textContent = textoForaHorario(cfg.accept_orders_when_closed);
        marcarSujo();
        return;
      }
      if (ev.target.closest("[data-recarregar-entrega]")) { estado.entregaCarregada = false; renderEntrega(); return; }
      if (ev.target.closest("[data-nova-zona]")) { guardarEntrega(); abrirFormZona(null); return; }
      const modo = ev.target.closest("[data-modo]");
      if (modo) { trocarModoEntrega(modo.dataset.modo); return; }
      const chaveEnt = ev.target.closest("[data-chave-entrega]");
      if (chaveEnt && chaveEnt.dataset.chaveEntrega !== "zona-ativa") {
        alternarChaveEntrega(chaveEnt.dataset.chaveEntrega); return;
      }
      const za = ev.target.closest("[data-zona-ativa]");
      if (za) { alternarZona(za.dataset.zonaAtiva, za); return; }
      const ze = ev.target.closest("[data-zona-editar]");
      if (ze) { guardarEntrega(); abrirFormZona(ze.dataset.zonaEditar); return; }
      const zx = ev.target.closest("[data-zona-excluir]");
      if (zx) { pedirExclusaoZona(zx.dataset.zonaExcluir); return; }
      const zs = ev.target.closest("[data-zona-subir]");
      if (zs) { moverZona(zs.dataset.zonaSubir, -1); return; }
      const zd = ev.target.closest("[data-zona-descer]");
      if (zd) { moverZona(zd.dataset.zonaDescer, 1); return; }

      if (ev.target.closest("[data-novo-dominio]")) { abrirFormDominio(); return; }
      if (ev.target.closest("[data-recarregar-dominios]")) { estado.dominiosCarregados = false; renderDominios(); return; }
      const dp = ev.target.closest("[data-dom-principal]");
      if (dp) { pedirPrincipal(dp.dataset.domPrincipal); return; }
      const da = ev.target.closest("[data-dom-ativo]");
      if (da) { alternarDominio(da.dataset.domAtivo, da); return; }
      const dx = ev.target.closest("[data-dom-excluir]");
      if (dx) { pedirExclusaoDominio(dx.dataset.domExcluir); return; }

      const cs = ev.target.closest("[data-subir]");
      if (cs) { moverCategoria(cs.dataset.subir, -1); return; }
      const cd = ev.target.closest("[data-descer]");
      if (cd) { moverCategoria(cd.dataset.descer, 1); return; }
    });

    /* Campos de horário (tela Horários) — delegação única no documento. */
    document.addEventListener("input", function (ev) {
      const alvo = ev.target;
      if (!alvo.dataset || !alvo.dataset.hora) return;
      const d = estado.horarios[Number(alvo.dataset.dia)];
      if (!d) return;
      d[alvo.dataset.hora] = alvo.value;
      alvo.classList.remove("invalido");
      const cartao = $("#dia-" + d.dia);
      if (cartao) {
        const estadoTexto = cartao.querySelector(".dia-estado");
        if (estadoTexto) estadoTexto.textContent = (d.abre && d.fecha) ? d.abre + " às " + d.fecha : "Informe os horários";
        const aviso = cartao.querySelector(".aviso-madrugada");
        if (fechaNoDiaSeguinte(d) && !aviso) {
          cartao.insertAdjacentHTML("beforeend", '<p class="aviso-madrugada">Fecha no dia seguinte.</p>');
        } else if (!fechaNoDiaSeguinte(d) && aviso) {
          aviso.remove();
        }
      }
      const erro = $("#erro-horarios");
      if (erro) erro.hidden = true;
      marcarSujo();
    });

    /* Delegação do formulário: UMA vez, no container permanente. */
    const folhaCorpo = $("#folha-corpo");
    folhaCorpo.addEventListener("click", formCliquou);
    folhaCorpo.addEventListener("input", formDigitou);
    folhaCorpo.addEventListener("change", formMudou);

    $("#cortina").addEventListener("click", fecharFolha);
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !$("#folha").hidden) fecharFolha();
    });
  }

  /* ---------- INÍCIO ------------------------------------------------ */
  async function iniciar() {
    ligarEventos();

    /* O ouvinte de sessão é registrado ANTES de qualquer desvio.
       Abaixo existem caminhos que terminam a função mais cedo (link
       vencido, convite sem sessão); se o registro ficasse no fim, esses
       caminhos sairiam sem ouvinte nenhum — e o login feito logo em
       seguida, na mesma página, não teria quem preenchesse
       estado.usuario. */
    sb.auth.onAuthStateChange(function (evento, sessao) {
      if (evento === "SIGNED_OUT") {
        limparPendente(estado.usuario && estado.usuario.id);   // antes de zerar
        estado.usuario = null;
        mostrarTela("login");
      } else if (sessao && sessao.user) { estado.usuario = sessao.user; }
    });

    /* Link de e-mail que o Supabase já recusou (vencido, usado duas
       vezes): não há sessão nenhuma para esperar. */
    if (ENTRADA.temErro) { conviteInvalido(); return; }

    try {
      /* Com detectSessionInUrl ligado, é aqui que o SDK termina de
         transformar o link do convite em sessão. */
      const { data } = await sb.auth.getSession();
      const sessao = data && data.session;

      if (!sessao) {
        /* Veio por um link de convite, mas não sobrou sessão: o link não
           vale mais. */
        if (ENTRADA.primeiroAcesso) { conviteInvalido(); return; }
        mostrarTela("login");
      } else if (ENTRADA.primeiroAcesso || pendenteDe(sessao.user && sessao.user.id)) {
        /* Ou o link acabou de chegar, ou esta MESMA conta já tinha um
           primeiro acesso em aberto — inclusive de uma aba fechada sem
           criar a senha. */
        estado.usuario = sessao.user;
        limparUrl();                     // tokens saem antes de a tela aparecer
        telaCriarSenha(sessao.user);     // senha primeiro; painel só depois
      } else {
        /* Caminho de sempre: sessão guardada ou login por senha. */
        estado.usuario = sessao.user;
        await iniciarSessao();
      }
    } catch (e) {
      console.error("[admin]", e);
      if (ENTRADA.primeiroAcesso) { conviteInvalido(); return; }
      mostrarTela("login");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();