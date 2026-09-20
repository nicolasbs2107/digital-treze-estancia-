/* =====================================================================
   ADMINISTRAÇÃO DA PLATAFORMA — SUPER ADMIN
   ---------------------------------------------------------------------
   Usa a MESMA chave publicável do site público e do painel do
   estabelecimento (../supabase-config.js). Nenhuma chave secreta,
   nenhum service_role, nenhuma Admin API do Supabase no navegador.

   Quem autoriza de verdade é o banco:
     • is_platform_admin()          — diz se esta conta é super admin
     • superadmin_list_businesses_v2() — lista as empresas, com status
     • superadmin_create_business()    — cria a empresa (numa transação)
     • superadmin_set_business_status()— suspende e reativa
     • superadmin_delete_business()    — exclui, conferindo o nome
     • provision-business-admin        — Edge Function que convida o dono

   Todas as RPCs recusam sozinhas quem não é super admin, com errcode
   42501. A Edge Function responde 403. Esconder botão é conforto de
   interface, não segurança: a segurança está do lado de lá.

   1. Cliente e estado          5. Visão geral
   2. Utilidades e UI           6. Empresas (lista e busca)
   3. Acesso (login e checagem) 7. Novo cliente
   4. Dados da plataforma       8. Convite do responsável
                                9. Eventos e início
   ===================================================================== */
(function () {
    "use strict";

    /* ---------- 1. CLIENTE E ESTADO ----------------------------------- */

    /* detectSessionInUrl FICA DESLIGADO de propósito.
  
       Esta área não tem nenhum fluxo de e-mail: não há convite, não há
       cadastro, não há "criar senha". O único jeito de entrar é digitando
       e-mail e senha. Com a detecção ligada, um link de convite do painel
       do estabelecimento aberto por engano neste endereço viraria sessão
       silenciosamente aqui dentro. Desligada, o token na URL simplesmente
       não é lido — e a URL ainda é limpa logo abaixo. */
    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });

    const NOME_FUNCAO_CONVITE = "provision-business-admin";
    const CAMINHO_PAINEL = "../admin/";

    const estado = {
        usuario: null,
        aba: "visao",
        empresas: [],
        carregandoLista: false,
        erroLista: null,
        busca: "",
        /* aviso persistente da criação parcial (empresa criada, convite não
           enviado). Fica na tela até a pessoa fechar. */
        aviso: null
    };

    /* ---------- 2. UTILIDADES E UI ------------------------------------ */
    const $ = (s, c) => (c || document).querySelector(s);
    const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));

    const esc = (s) => String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

    const semAcento = (s) => String(s == null ? "" : s).normalize("NFD")
        .split("").filter((c) => { const k = c.charCodeAt(0); return k < 0x300 || k > 0x36f; })
        .join("").toLowerCase();

    /* A RPC devolve bigint; conforme o driver isso chega como número ou
       como texto, e pode vir null. Aqui vira sempre um inteiro. */
    const inteiro = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.trunc(n) : 0;
    };

    const texto = (v) => {
        const t = String(v == null ? "" : v).trim();
        return t;
    };

    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ehUuid = (v) => typeof v === "string" && UUID.test(v.trim());

    /* Mostra o WhatsApp como as pessoas leem, sem alterar o que está
       gravado. Formato desconhecido volta como veio. */
    function formatarWhats(valor) {
        const cru = texto(valor);
        if (!cru) return "";
        let d = cru.replace(/\D/g, "");
        if (d.length > 11 && d.indexOf("55") === 0) d = d.slice(2);
        if (d.length === 11) return "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7);
        if (d.length === 10) return "(" + d.slice(0, 2) + ") " + d.slice(2, 6) + "-" + d.slice(6);
        return cru;
    }

    function formatarData(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        const p = (n) => String(n).padStart(2, "0");
        return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear();
    }

    let toastTimer = null;
    function toast(txt, tipo) {
        const el = $("#toast");
        el.className = "toast" + (tipo ? " " + tipo : "");
        const icone = tipo === "erro" ? "!" : tipo === "atencao" ? "!" : "✓";
        el.innerHTML = '<span aria-hidden="true">' + icone + "</span><span>" + esc(txt) + "</span>";
        el.classList.add("visivel");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove("visivel"), 3600);
    }

    /* Traduz o que o banco devolve. Nada de stack trace na tela. */
    function mensagemErro(e) {
        const m = texto(e && (e.message || e.error_description));
        if (/ACCESS DENIED|42501|permission denied|row-level security/i.test(m)) {
            return "Sua conta não tem acesso à administração da plataforma.";
        }
        if (/Failed to fetch|NetworkError|network error/i.test(m)) {
            return "Sem conexão com o servidor. Tente de novo.";
        }
        if (/JWT|token is expired|invalid claim/i.test(m)) {
            return "Sua sessão expirou. Entre novamente.";
        }
        if (/duplicate key|violates|relation \"|column \"|syntax error|function .* does not exist/i.test(m)) {
            return "Não foi possível concluir a operação. Tente novamente.";
        }
        return m || "Não foi possível concluir. Tente novamente.";
    }

    /* As mensagens que a própria superadmin_create_business levanta já
       foram escritas para o usuário final (nome obrigatório, slug repetido,
       WhatsApp inválido). Essas passam inteiras; o resto cai no tradutor. */
    const MENSAGEM_DA_RPC = /^(O nome |O slug |O WhatsApp |WhatsApp inválido|Já existe uma empresa|Não foi possível gerar)/;
    function mensagemCriacao(e) {
        const m = texto(e && (e.message || e.error_description));
        if (MENSAGEM_DA_RPC.test(m)) return m;
        return mensagemErro(e);
    }

    const ocupado = (btn, sim) => {
        if (!btn) return;
        btn.classList.toggle("carregando", !!sim);
        btn.disabled = !!sim;
    };

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
            if (!$("#folha").classList.contains("aberta")) {
                $("#folha").hidden = true;
                $("#cortina").hidden = true;
            }
        }, 280);
        const cb = aoFechar; aoFechar = null;
        if (cb) cb();
    }

    function erroNoForm(mensagem) {
        const el = $("#erro-form");
        if (!el) return;
        el.textContent = mensagem;
        el.hidden = false;
        $("#folha-corpo").scrollTop = $("#folha-corpo").scrollHeight;
    }
    function limparErroForm() {
        const el = $("#erro-form");
        if (el) el.hidden = true;
        $$("#folha-corpo .invalido").forEach((i) => i.classList.remove("invalido"));
    }

    function mostrarTela(qual) {
        $("#tela-carregando").hidden = qual !== "carregando";
        $("#tela-login").hidden = qual !== "login";
        $("#tela-restrito").hidden = qual !== "restrito";
        $("#tela-painel").hidden = qual !== "painel";
    }

    /* Nada de token de e-mail na barra de endereços desta área. Como o
       detectSessionInUrl está desligado, o SDK não limpa nada sozinho. */
    const PARAMS_DE_AUTH = [
        "access_token", "refresh_token", "expires_in", "expires_at", "token_type",
        "type", "provider_token", "provider_refresh_token",
        "code", "token_hash", "error", "error_code", "error_description"
    ];
    function limparUrl() {
        try {
            const url = new URL(window.location.href);
            let mudou = false;
            PARAMS_DE_AUTH.forEach(function (k) {
                if (url.searchParams.has(k)) { url.searchParams.delete(k); mudou = true; }
            });
            if (url.hash && /access_token|refresh_token|error|type=/.test(url.hash)) {
                url.hash = ""; mudou = true;
            }
            if (mudou) history.replaceState(null, document.title, url.pathname + url.search);
        } catch (e) { /* navegador sem History API: segue sem limpar */ }
    }

    /* ---------- 3. ACESSO (LOGIN E CHECAGEM) --------------------------
       Duas perguntas, nesta ordem: existe sessão? essa conta é super admin?
       A segunda é respondida pelo banco, por is_platform_admin(). O front
       não decide nada — só desenha o resultado.
       ------------------------------------------------------------------ */

    async function entrar(ev) {
        ev.preventDefault();
        const btn = $("#btn-entrar");
        if (btn.disabled) return;

        const email = $("#login-email").value.trim();
        const senha = $("#login-senha").value;
        const erro = $("#erro-login");
        erro.hidden = true;

        if (!email || !senha) {
            erro.textContent = "Preencha e-mail e senha.";
            erro.hidden = false;
            return;
        }

        ocupado(btn, true);
        try {
            const r = await sb.auth.signInWithPassword({ email: email, password: senha });
            if (r.error) throw r.error;
            $("#login-senha").value = "";
            estado.usuario = (r.data && r.data.user) || (r.data && r.data.session && r.data.session.user) || null;
            await abrirComSessao();
        } catch (e) {
            const m = texto(e && e.message);
            erro.textContent = /Invalid login|invalid_credentials/i.test(m)
                ? "E-mail ou senha incorretos. Confira e tente de novo."
                : /Email not confirmed/i.test(m) ? "Este e-mail ainda não foi confirmado."
                    : mensagemErro(e);
            erro.hidden = false;
            $("#login-senha").focus();
        } finally {
            ocupado(btn, false);
        }
    }

    async function sair() {
        try { await sb.auth.signOut(); } catch (e) { /* segue para a tela de login */ }
        estado.usuario = null;
        estado.empresas = [];
        estado.busca = "";
        estado.aviso = null;
        estado.erroLista = null;
        estado.aba = "visao";
        mostrarTela("login");
    }

    /* A conta entrou mas não é super admin — ou não deu para perguntar.
       Em nenhum dos dois casos alguma empresa é carregada. */
    function telaSemAcesso(motivo) {
        const falhou = motivo === "falha";
        $("#restrito-titulo").textContent = falhou ? "Não foi possível confirmar o acesso" : "Acesso restrito";
        $("#restrito-texto").textContent = falhou
            ? "Não conseguimos confirmar as permissões desta conta agora. Verifique a conexão e tente de novo."
            : "Esta conta não possui acesso à administração da plataforma.";
        $("#restrito-email").textContent = (estado.usuario && estado.usuario.email) || "";
        $("#btn-tentar-de-novo").hidden = !falhou;
        mostrarTela("restrito");
    }

    /* Pergunta ao banco se quem está logado é super admin.
       Três respostas possíveis: sim, não, e "não deu para perguntar" —
       e as três são tratadas de forma diferente. Um erro de rede NÃO pode
       ser lido como "não é admin", nem o contrário. */
    async function ehSuperAdmin() {
        const { data, error } = await sb.rpc("is_platform_admin");
        if (error) throw error;
        return data === true;
    }

    async function abrirComSessao() {
        mostrarTela("carregando");
        let permitido;
        try {
            permitido = await ehSuperAdmin();
        } catch (e) {
            console.error("[superadmin]", e);
            /* 42501 / permissão negada é uma recusa clara; o resto é falha. */
            const m = texto(e && e.message);
            if (/ACCESS DENIED|42501|permission denied/i.test(m)) telaSemAcesso("sem-acesso");
            else telaSemAcesso("falha");
            return;
        }

        if (!permitido) { telaSemAcesso("sem-acesso"); return; }

        $("#topo-email").textContent = (estado.usuario && estado.usuario.email) || "";
        mostrarTela("painel");
        irPara(estado.aba);
        await recarregar();
    }

    /* ---------- 4. DADOS DA PLATAFORMA --------------------------------
       Uma única fonte: superadmin_list_businesses(). O frontend não lê
       businesses, business_members nem business_domains diretamente.
       ------------------------------------------------------------------ */

    /* A linha é normalizada aqui, uma vez, para o resto do arquivo poder
       confiar nos tipos. Campo nulo vira string vazia ou zero — nunca
       "null" escrito na tela, nunca NaN numa conta. */
    function normalizarEmpresa(linha) {
        const l = linha || {};
        return {
            id: ehUuid(l.id) ? String(l.id).trim() : "",
            nome: texto(l.name),
            slug: texto(l.slug),
            whatsapp: texto(l.whatsapp),
            criadaEm: texto(l.created_at),
            atualizadaEm: texto(l.updated_at),
            produtos: inteiro(l.products_count),
            membros: inteiro(l.members_count),
            dominio: texto(l.primary_domain),
            /* Só dois estados existem hoje. Qualquer coisa diferente de
               "suspended" conta como ativa — um valor novo no banco não pode
               fazer a listagem sumir nem travar uma empresa que funciona. */
            status: l.status === "suspended" ? "suspended" : "active",
            suspensaEm: texto(l.suspended_at),
            motivoSuspensao: texto(l.suspension_reason)
        };
    }

    const suspensa = (e) => !!e && e.status === "suspended";

    /* v2: a mesma listagem de antes, agora trazendo status, suspended_at e
       suspension_reason. Empresas suspensas continuam aparecendo aqui —
       quem as esconde é a resolução por domínio, no site público. */
    async function listarEmpresas() {
        const { data, error } = await sb.rpc("superadmin_list_businesses_v2");
        if (error) throw error;
        const linhas = Array.isArray(data) ? data : (data ? [data] : []);
        return linhas.map(normalizarEmpresa);
    }

    async function recarregar() {
        estado.carregandoLista = true;
        render();
        try {
            estado.empresas = await listarEmpresas();
            estado.erroLista = null;
        } catch (e) {
            console.error("[superadmin]", e);
            estado.erroLista = mensagemErro(e);
        } finally {
            estado.carregandoLista = false;
            render();
        }
    }

    function empresaPorId(id) {
        return estado.empresas.find((e) => e.id === id) || null;
    }

    function resumo() {
        const total = estado.empresas.length;
        const comResponsavel = estado.empresas.filter((e) => e.membros > 0).length;
        const suspensas = estado.empresas.filter(suspensa).length;
        return {
            total: total,
            ativas: total - suspensas,
            suspensas: suspensas,
            comResponsavel: comResponsavel,
            semResponsavel: total - comResponsavel,
            comDominio: estado.empresas.filter((e) => !!e.dominio).length
        };
    }

    /* ---------- 5. VISÃO GERAL ---------------------------------------- */

    function irPara(aba) {
        estado.aba = aba;
        $$("[data-aba]").forEach(function (b) {
            b.setAttribute("aria-current", String(b.dataset.aba === aba));
        });
        window.scrollTo({ top: 0 });
        render();
    }

    function render() {
        if ($("#tela-painel").hidden) return;
        fecharMenu();                     // os botões âncora somem no redesenho
        const alvo = $("#conteudo");
        alvo.innerHTML = htmlAviso() + (estado.aba === "empresas" ? htmlEmpresas() : htmlVisao());
        if (estado.aba === "empresas") {
            renderListaEmpresas();
            const campo = $("#campo-busca");
            if (campo) campo.value = estado.busca;
        }
    }

    function htmlAviso() {
        if (!estado.aviso) return "";
        return '' +
            '<div class="faixa-aviso" role="status">' +
            '<span aria-hidden="true">⚠️</span>' +
            '<div class="texto">' + estado.aviso + "</div>" +
            '<button type="button" class="fechar-faixa" data-fechar-aviso aria-label="Fechar aviso">×</button>' +
            "</div>";
    }

    function cartao(rotulo, valor, classe) {
        return '<div class="cartao-num' + (classe ? " " + classe : "") + '">' +
            '<div class="rotulo">' + esc(rotulo) + "</div>" +
            '<div class="valor">' + esc(String(valor)) + "</div>" +
            "</div>";
    }

    function htmlCartoes() {
        if (estado.carregandoLista && !estado.empresas.length) {
            return '<div class="cartoes">' +
                cartao("Empresas", "—") + cartao("Ativas", "—") +
                cartao("Suspensas", "—") + cartao("Sem responsável", "—") +
                "</div>";
        }
        /* "Com domínio" saiu dos cartões para dar lugar a Ativas/Suspensas —
           a informação continua inteira na coluna Domínio da lista. */
        const r = resumo();
        return '<div class="cartoes">' +
            cartao("Empresas", r.total, "destaque") +
            cartao("Ativas", r.ativas, "boa") +
            cartao("Suspensas", r.suspensas, r.suspensas > 0 ? "suspensa" : "") +
            cartao("Sem responsável", r.semResponsavel, r.semResponsavel > 0 ? "atencao" : "") +
            "</div>";
    }

    function htmlVisao() {
        const r = resumo();

        let semDono = "";
        if (!estado.carregandoLista && estado.empresas.length) {
            const pendentes = estado.empresas.filter((e) => e.membros === 0).slice(0, 6);
            semDono = '<div class="painel-caixa">' +
                "<h3>Empresas sem responsável</h3>" +
                (pendentes.length
                    ? '<div class="lista-simples">' + pendentes.map(function (e) {
                        return '<div class="item-simples">' +
                            "<div>" +
                            '<div class="nome">' + esc(e.nome || "(sem nome)") + "</div>" +
                            '<div class="detalhe">' + esc(e.slug || "sem slug") + "</div>" +
                            "</div>" +
                            '<button type="button" class="btn btn-principal btn-mini" data-convidar="' + esc(e.id) + '">Convidar responsável</button>' +
                            "</div>";
                    }).join("") + "</div>" +
                    (r.semResponsavel > pendentes.length
                        ? '<p class="dica" style="margin-top:10px">e mais ' + (r.semResponsavel - pendentes.length) + " em Empresas.</p>"
                        : "")
                    : '<p class="dica">Todas as empresas já têm um responsável cadastrado.</p>') +
                "</div>";
        }

        let recentes = "";
        if (!estado.carregandoLista && estado.empresas.length) {
            const ultimas = estado.empresas.slice()
                .sort(function (a, b) { return String(b.criadaEm).localeCompare(String(a.criadaEm)); })
                .slice(0, 5);
            recentes = '<div class="painel-caixa">' +
                "<h3>Últimas empresas criadas</h3>" +
                '<div class="lista-simples">' + ultimas.map(function (e) {
                    return '<div class="item-simples">' +
                        "<div>" +
                        '<div class="nome">' + esc(e.nome || "(sem nome)") + "</div>" +
                        '<div class="detalhe">' + esc(e.slug || "sem slug") +
                        (e.criadaEm ? " · " + esc(formatarData(e.criadaEm)) : "") + "</div>" +
                        "</div>" +
                        '<span class="etiqueta ' + (e.dominio ? "dominio" : "atencao") + '">' +
                        esc(e.dominio || "Sem domínio") + "</span>" +
                        "</div>";
                }).join("") + "</div>" +
                "</div>";
        }

        return "" +
            '<h1 class="saudacao">Visão geral</h1>' +
            "<p>Estabelecimentos atendidos por esta plataforma.</p>" +
            htmlCartoes() +
            (estado.erroLista ? '<div class="aviso-form">' + esc(estado.erroLista) + "</div>" : "") +
            '<div class="atalhos">' +
            '<button type="button" class="btn btn-principal" data-novo-cliente>+ Novo cliente</button>' +
            '<button type="button" class="btn btn-secundario" data-aba="empresas">Ver todas as empresas</button>' +
            '<button type="button" class="btn btn-fantasma" data-recarregar>Atualizar</button>' +
            "</div>" +
            semDono +
            recentes;
    }

    /* ---------- 6. EMPRESAS (LISTA E BUSCA) --------------------------- */

    function htmlEmpresas() {
        return "" +
            '<div class="cabeca-pagina">' +
            "<div>" +
            "<h2>Empresas</h2>" +
            "<p>Cada empresa é um estabelecimento com painel próprio.</p>" +
            "</div>" +
            '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
            '<button type="button" class="btn btn-fantasma" data-recarregar>Atualizar</button>' +
            '<button type="button" class="btn btn-principal" data-novo-cliente>+ Novo cliente</button>' +
            "</div>" +
            "</div>" +
            htmlCartoes() +
            '<div class="barra-busca" style="margin-top:20px">' +
            '<div class="busca-caixa">' +
            '<span class="lupa" aria-hidden="true">⌕</span>' +
            '<input class="entrada" id="campo-busca" type="search" autocomplete="off" ' +
            'placeholder="Buscar por nome ou slug" aria-label="Buscar empresa por nome ou slug">' +
            "</div>" +
            '<p class="contagem-busca" id="contagem-busca"></p>' +
            "</div>" +
            '<div id="lista-empresas"></div>';
    }

    function empresasFiltradas() {
        const t = semAcento(estado.busca).trim();
        if (!t) return estado.empresas;
        return estado.empresas.filter(function (e) {
            return semAcento(e.nome).indexOf(t) >= 0 || semAcento(e.slug).indexOf(t) >= 0;
        });
    }

    function celula(rotulo, conteudo, classe) {
        return '<div class="celula' + (classe ? " " + classe : "") + '" data-rotulo="' + esc(rotulo) + '">' +
            '<span class="valor-celula">' + conteudo + "</span></div>";
    }

    /* Status em duas linhas no máximo: o selo e, só quando suspensa e só
       quando existir, o motivo e a data. A tabela não engorda por isso. */
    function celulaStatus(e) {
        if (!suspensa(e)) {
            return celula("Status", '<span class="selo-status ativa">Ativa</span>', "status");
        }
        const detalhe = [
            e.motivoSuspensao ? esc(e.motivoSuspensao) : "",
            e.suspensaEm ? "Suspensa em " + esc(formatarData(e.suspensaEm)) : ""
        ].filter(Boolean);
        return celula("Status",
            '<span class="selo-status suspensa">Suspensa</span>' +
            (detalhe.length ? '<span class="detalhe-status">' + detalhe.join(" · ") + "</span>" : ""),
            "status");
    }

    function linhaEmpresa(e) {
        const semDono = e.membros === 0;
        return '<article class="linha-empresa' + (suspensa(e) ? " empresa-suspensa" : "") + '">' +
            /* O slug acompanha o nome: com a coluna Status, oito colunas não
               cabiam sem espremer tudo. Continua visível, logo abaixo. */
            '<div class="celula principal">' +
            '<div class="nome-empresa">' + esc(e.nome || "(sem nome)") + "</div>" +
            '<div class="slug-empresa">' + (e.slug ? esc(e.slug) : "sem slug") + "</div>" +
            "</div>" +
            celulaStatus(e) +
            celula("WhatsApp", e.whatsapp
                ? esc(formatarWhats(e.whatsapp))
                : '<span class="sem-dado">—</span>', "telefone") +
            celula("Produtos", '<span class="num">' + e.produtos + "</span>", "numero") +
            celula("Responsáveis", semDono
                ? '<span class="etiqueta atencao">Sem responsável</span>'
                : '<span class="num">' + e.membros + "</span>") +
            celula("Domínio", e.dominio
                ? esc(e.dominio)
                : '<span class="sem-dado">Sem domínio</span>') +
            '<div class="celula acoes">' +
            (semDono
                ? '<button type="button" class="btn btn-principal btn-mini" data-convidar="' + esc(e.id) + '">Convidar responsável</button>'
                : "") +
            (suspensa(e)
                ? '<button type="button" class="btn btn-secundario btn-mini" data-reativar="' + esc(e.id) + '">Reativar</button>'
                : '<button type="button" class="btn btn-fantasma btn-mini" data-suspender="' + esc(e.id) + '">Suspender</button>') +
            /* A exclusão não fica solta na tabela: mora atrás de "Mais
               opções", longe do dedo que só queria suspender. */
            '<button type="button" class="btn-mais" data-mais="' + esc(e.id) + '"' +
            ' aria-label="Mais opções de ' + esc(e.nome || "empresa") + '">⋯</button>' +
            "</div>" +
            "</article>";
    }

    function renderListaEmpresas() {
        const alvo = $("#lista-empresas");
        const contagem = $("#contagem-busca");
        if (!alvo) return;

        if (estado.carregandoLista && !estado.empresas.length) {
            if (contagem) contagem.textContent = "";
            alvo.innerHTML = '<div class="esq"></div><div class="esq"></div><div class="esq"></div>';
            return;
        }

        if (estado.erroLista) {
            if (contagem) contagem.textContent = "";
            alvo.innerHTML = '<div class="vazio">' +
                '<div class="icone" aria-hidden="true">⚠️</div>' +
                "<strong>Não foi possível carregar as empresas</strong>" +
                "<p>" + esc(estado.erroLista) + "</p>" +
                '<button type="button" class="btn btn-secundario" data-recarregar>Tentar de novo</button>' +
                "</div>";
            return;
        }

        if (!estado.empresas.length) {
            if (contagem) contagem.textContent = "";
            alvo.innerHTML = '<div class="vazio">' +
                '<div class="icone" aria-hidden="true">🏪</div>' +
                "<strong>Nenhuma empresa cadastrada</strong>" +
                "<p>Crie o primeiro cliente da plataforma.</p>" +
                '<button type="button" class="btn btn-principal" data-novo-cliente>+ Novo cliente</button>' +
                "</div>";
            return;
        }

        const lista = empresasFiltradas();
        if (contagem) {
            contagem.textContent = estado.busca.trim()
                ? lista.length + (lista.length === 1 ? " empresa encontrada" : " empresas encontradas")
                : estado.empresas.length + (estado.empresas.length === 1 ? " empresa" : " empresas");
        }

        if (!lista.length) {
            alvo.innerHTML = '<div class="vazio">' +
                '<div class="icone" aria-hidden="true">⌕</div>' +
                "<strong>Nada encontrado</strong>" +
                "<p>Nenhuma empresa com esse nome ou slug.</p>" +
                "</div>";
            return;
        }

        alvo.innerHTML = '<div class="tabela">' +
            '<div class="cabecalho-tabela" aria-hidden="true">' +
            "<div>Empresa</div><div>Status</div><div>WhatsApp</div>" +
            '<div class="direita">Produtos</div><div>Responsáveis</div>' +
            "<div>Domínio principal</div><div></div>" +
            "</div>" +
            lista.map(linhaEmpresa).join("") +
            "</div>";
    }

    /* ---------- 7. NOVO CLIENTE ---------------------------------------
       Duas operações separadas, nesta ordem: criar a empresa e convidar o
       responsável. Se a primeira falhar, nada acontece. Se a segunda
       falhar, a empresa CONTINUA CRIADA — não se tenta criar de novo e não
       se apaga nada. Ela aparece na lista como "Sem responsável", e o
       convite pode ser reenviado dali.
       ------------------------------------------------------------------ */

    const EMAIL_SIMPLES = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    function abrirNovoCliente() {
        const corpo = "" +
            '<p class="dica">A empresa nasce vazia: sem domínio, sem produtos e com o Delivery desligado. ' +
            "O responsável define a senha pelo convite que receber por e-mail.</p>" +

            '<div class="campo">' +
            '<label for="novo-nome">Nome do estabelecimento <span class="marca-obrigatorio">*</span></label>' +
            '<input id="novo-nome" type="text" maxlength="120" autocomplete="off" placeholder="Como aparece para o cliente">' +
            "</div>" +

            '<div class="campo">' +
            '<label for="novo-whats">WhatsApp <span class="marca-obrigatorio">*</span></label>' +
            '<input id="novo-whats" type="tel" inputmode="tel" autocomplete="off" placeholder="(14) 99999-0000">' +
            '<p class="dica" style="margin-top:6px">É o número que vai receber os pedidos do cardápio.</p>' +
            "</div>" +

            '<div class="campo">' +
            '<label for="novo-slug">Slug <span class="opcional">OPCIONAL</span></label>' +
            '<input id="novo-slug" type="text" autocomplete="off" placeholder="deixe em branco para gerar do nome">' +
            '<p class="dica" style="margin-top:6px">Identificador interno da empresa. Em branco, o banco gera a partir do nome.</p>' +
            "</div>" +

            '<div class="campo">' +
            '<label for="novo-email">E-mail do responsável <span class="marca-obrigatorio">*</span></label>' +
            '<input id="novo-email" type="email" autocomplete="off" placeholder="responsavel@empresa.com">' +
            "</div>" +

            '<label class="caixa-marcar" for="novo-categorias">' +
            '<input type="checkbox" id="novo-categorias" checked>' +
            '<span class="texto">Criar categorias padrão de pizzaria' +
            "<small>Pizzas salgadas, doces, bebidas e afins. Podem ser renomeadas ou apagadas depois.</small>" +
            "</span>" +
            "</label>" +

            '<div class="aviso-info">Nenhuma senha é definida aqui. O responsável recebe um convite por e-mail e cria a própria senha no primeiro acesso.</div>' +
            '<p class="aviso-form" id="erro-form" hidden></p>';

        const rodape =
            '<button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>' +
            '<button type="button" class="btn btn-principal" id="btn-criar">Criar empresa</button>';

        abrirFolha("Novo cliente", corpo, rodape);
        $("#btn-criar").addEventListener("click", criarCliente);
        setTimeout(function () { const c = $("#novo-nome"); if (c) c.focus(); }, 320);
    }

    /* superadmin_create_business devolve uma TABLE, então o SDK entrega um
       array de linhas. Mas o formato pode variar conforme a versão e o
       jeito da chamada: array, objeto único ou até o próprio uuid. Aqui a
       procura é por business_id (e, como alternativa, id) em qualquer um
       desses formatos — e o valor só é aceito se for um UUID de verdade.
       Nada é inventado: sem UUID válido, devolve null. */
    function extrairBusinessId(data) {
        const vistos = new Set();
        function olhar(valor, nivel) {
            if (valor == null || nivel > 3) return null;
            if (typeof valor === "string") return ehUuid(valor) ? valor.trim() : null;
            if (Array.isArray(valor)) {
                for (let i = 0; i < valor.length; i++) {
                    const achado = olhar(valor[i], nivel + 1);
                    if (achado) return achado;
                }
                return null;
            }
            if (typeof valor === "object") {
                if (vistos.has(valor)) return null;
                vistos.add(valor);
                const chaves = ["business_id", "id"];
                for (let i = 0; i < chaves.length; i++) {
                    const achado = olhar(valor[chaves[i]], nivel + 1);
                    if (achado) return achado;
                }
                return null;
            }
            return null;
        }
        return olhar(data, 0);
    }

    function extrairNome(data, alternativo) {
        const linha = Array.isArray(data) ? data[0] : data;
        if (linha && typeof linha === "object" && texto(linha.name)) return texto(linha.name);
        return alternativo;
    }

    async function criarCliente() {
        const btn = $("#btn-criar");
        if (!btn || btn.disabled) return;
        limparErroForm();

        const nome = $("#novo-nome").value.trim();
        const whats = $("#novo-whats").value.trim();
        const slug = $("#novo-slug").value.trim();
        const email = $("#novo-email").value.trim();
        const categorias = $("#novo-categorias").checked;

        /* Conferência local: só para não gastar uma ida ao servidor com algo
           obviamente vazio. Quem valida de verdade é a RPC. */
        if (!nome) { $("#novo-nome").classList.add("invalido"); erroNoForm("Informe o nome do estabelecimento."); $("#novo-nome").focus(); return; }
        if (!whats) { $("#novo-whats").classList.add("invalido"); erroNoForm("Informe o WhatsApp que vai receber os pedidos."); $("#novo-whats").focus(); return; }
        if (whats.replace(/\D/g, "").length < 10) {
            $("#novo-whats").classList.add("invalido");
            erroNoForm("WhatsApp incompleto. Informe DDD + número.");
            $("#novo-whats").focus(); return;
        }
        if (!email) { $("#novo-email").classList.add("invalido"); erroNoForm("Informe o e-mail do responsável."); $("#novo-email").focus(); return; }
        if (!EMAIL_SIMPLES.test(email)) {
            $("#novo-email").classList.add("invalido");
            erroNoForm("E-mail do responsável inválido.");
            $("#novo-email").focus(); return;
        }

        ocupado(btn, true);

        /* ---- passo 1: a empresa ---- */
        let resposta;
        try {
            const r = await sb.rpc("superadmin_create_business", {
                p_name: nome,
                p_slug: slug || null,
                p_whatsapp: whats,
                p_create_pizzeria_categories: categorias
            });
            if (r.error) throw r.error;
            resposta = r.data;
        } catch (e) {
            console.error("[superadmin]", e);
            /* A empresa NÃO foi criada: a RPC é uma transação só. O modal
               continua aberto com os dados preenchidos para corrigir. */
            ocupado(btn, false);
            erroNoForm(mensagemCriacao(e));
            return;
        }

        /* ---- daqui para baixo a empresa JÁ EXISTE ----
           Nenhuma linha abaixo pode criar outra empresa nem apagar esta. */
        const businessId = extrairBusinessId(resposta);
        const nomeCriado = extrairNome(resposta, nome);

        let convite = { ok: false, mensagem: "" };
        if (!businessId) {
            convite.mensagem = "Não foi possível identificar a empresa recém-criada para enviar o convite.";
        } else {
            try {
                const r = await enviarConvite(businessId, email);
                convite = { ok: true, jaVinculado: r.jaVinculado };
            } catch (e) {
                console.error("[superadmin]", e);
                convite.mensagem = e && e.amigavel ? e.amigavel : mensagemErro(e);
            }
        }

        fecharFolha();

        if (convite.ok) {
            toast(convite.jaVinculado
                ? "Empresa criada. Este e-mail já era o responsável."
                : "Empresa criada e convite enviado.");
            estado.aviso = null;
        } else {
            /* Criação parcial. A empresa fica; o convite pode ser reenviado
               pela própria lista, sem recriar nada. */
            estado.aviso =
                "<b>Empresa criada com sucesso. O convite do responsável não pôde ser enviado.</b><br>" +
                esc(nomeCriado) + " já está na lista como <b>Sem responsável</b> — use o botão " +
                "<b>Convidar responsável</b> para tentar de novo. Motivo: " + esc(convite.mensagem);
            toast("Empresa criada. Convite não enviado.", "atencao");
        }

        if (estado.aba !== "empresas") irPara("empresas");
        await recarregar();
    }

    /* ---------- 8. CONVITE DO RESPONSÁVEL ------------------------------
       Só e-mail. O business_id vem do objeto que veio de
       superadmin_list_businesses() — nunca de algo digitado.
       O corpo enviado tem exatamente dois campos: business_id e email.
       Nada de role, user_id, redirectTo ou is_super_admin: a própria Edge
       Function recusa a requisição se qualquer um deles aparecer.
       ------------------------------------------------------------------ */

    const MENSAGENS_CONVITE = {
        email_in_use: "Este e-mail já possui uma conta no sistema.",
        owner_exists: "Esta empresa já possui um responsável principal.",
        forbidden: "Sua conta não tem acesso à administração da plataforma.",
        business_not_found: "Empresa não encontrada. Atualize a lista e tente de novo.",
        invalid_email: "E-mail inválido. Confira e tente de novo.",
        invalid_business_id: "Empresa inválida. Atualize a lista e tente de novo.",
        invalid_payload: "Não foi possível enviar o convite. Atualize a página e tente de novo.",
        forbidden_field: "Não foi possível enviar o convite. Atualize a página e tente de novo.",
        method_not_allowed: "Não foi possível enviar o convite. Atualize a página e tente de novo.",
        inconsistent_state: "O convite não foi concluído e restou um cadastro pela metade. Confira esta conta antes de tentar de novo.",
        internal_error: "Não foi possível enviar o convite agora. Tente novamente em instantes."
    };
    const CONVITE_GENERICO = "Não foi possível enviar o convite agora. Tente novamente em instantes.";

    /* Num status fora da faixa 2xx, o SDK devolve um FunctionsHttpError e
       o corpo da resposta fica em error.context — é de lá que sai o código
       estável (email_in_use, owner_exists...). Lendo como texto e
       interpretando depois, um corpo que não seja JSON não quebra nada. */
    async function corpoDoErro(erro) {
        const ctx = erro && erro.context;
        if (!ctx) return null;
        try {
            if (typeof ctx.text === "function") {
                const t = await ctx.text();
                try { return JSON.parse(t); } catch (e) { return null; }
            }
            if (typeof ctx.json === "function") return await ctx.json();
        } catch (e) { /* corpo já consumido ou indisponível */ }
        if (typeof ctx === "object" && (ctx.error || ctx.message)) return ctx;
        return null;
    }

    function falhaConvite(codigo, mensagemServidor) {
        const e = new Error(codigo || "invite_failed");
        e.codigo = codigo || "";
        /* Preferimos a nossa mensagem para os códigos conhecidos: é ela que
           está escrita para o usuário final. Código desconhecido cai no
           genérico — nunca no texto técnico do servidor. */
        e.amigavel = MENSAGENS_CONVITE[codigo] || CONVITE_GENERICO;
        e.servidor = texto(mensagemServidor);
        return e;
    }

    async function enviarConvite(businessId, email) {
        if (!ehUuid(businessId)) throw falhaConvite("invalid_business_id");

        const { data, error } = await sb.functions.invoke(NOME_FUNCAO_CONVITE, {
            body: { business_id: businessId, email: email }
        });

        if (error) {
            const corpo = await corpoDoErro(error);
            if (corpo && corpo.error) throw falhaConvite(String(corpo.error), corpo.message);
            const m = texto(error.message);
            if (/Failed to fetch|NetworkError/i.test(m)) {
                const rede = falhaConvite("");
                rede.amigavel = "Sem conexão com o servidor. O convite não foi enviado.";
                throw rede;
            }
            throw falhaConvite("");
        }

        /* Cinto e suspensório: se algum dia a função responder 200 com
           success:false, não tratamos isso como convite enviado. */
        if (data && data.success === false) throw falhaConvite(texto(data.error), data.message);

        return { jaVinculado: !!(data && data.already_linked) };
    }

    function abrirConvite(businessId) {
        const empresa = empresaPorId(businessId);
        if (!empresa) { toast("Empresa não encontrada. Atualize a lista.", "erro"); return; }

        const corpo = "" +
            '<div class="aviso-info">Convite para <b>' + esc(empresa.nome || "(sem nome)") + "</b>" +
            (empresa.slug ? " · " + esc(empresa.slug) : "") + "</div>" +
            '<div class="campo">' +
            '<label for="convite-email">E-mail do responsável <span class="marca-obrigatorio">*</span></label>' +
            '<input id="convite-email" type="email" autocomplete="off" placeholder="responsavel@empresa.com">' +
            "</div>" +
            '<p class="dica" style="margin-top:8px">Ele recebe um e-mail, cria a própria senha e entra no painel do estabelecimento. ' +
            "Nenhuma senha é definida aqui.</p>" +
            '<p class="aviso-form" id="erro-form" hidden></p>';

        const rodape =
            '<button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>' +
            '<button type="button" class="btn btn-principal" id="btn-convidar">Enviar convite</button>';

        abrirFolha("Convidar responsável", corpo, rodape);

        $("#btn-convidar").addEventListener("click", async function () {
            const btn = this;
            if (btn.disabled) return;
            limparErroForm();

            const email = $("#convite-email").value.trim();
            if (!email || !EMAIL_SIMPLES.test(email)) {
                $("#convite-email").classList.add("invalido");
                erroNoForm("Informe um e-mail válido.");
                $("#convite-email").focus();
                return;
            }

            ocupado(btn, true);
            try {
                /* O id vem do objeto da lista, não do que foi digitado. */
                const r = await enviarConvite(empresa.id, email);
                fecharFolha();
                toast(r.jaVinculado ? "Este e-mail já era o responsável desta empresa." : "Convite enviado.");
                await recarregar();
            } catch (e) {
                console.error("[superadmin]", e);
                ocupado(btn, false);
                erroNoForm(e && e.amigavel ? e.amigavel : CONVITE_GENERICO);
            }
        });

        setTimeout(function () { const c = $("#convite-email"); if (c) c.focus(); }, 320);
    }

    /* ---------- 8.1 STATUS DA EMPRESA ----------------------------------
       Suspender, reativar e excluir passam SEMPRE pelas RPCs protegidas.
       Não existe `sb.from("businesses").update(...)` nem `.delete()` neste
       arquivo: quem confere se quem chamou é super admin é o banco, em
       is_platform_admin(), e nenhum botão escondido substitui isso.
  
       O id vem sempre do objeto devolvido por superadmin_list_businesses_v2
       — nunca de algo digitado, nunca de um UUID escrito no código.
       ------------------------------------------------------------------ */

    async function definirStatus(businessId, status, motivo) {
        if (!ehUuid(businessId)) throw new Error("Empresa inválida. Atualize a lista.");
        const { error } = await sb.rpc("superadmin_set_business_status", {
            p_business_id: businessId,
            p_status: status,
            p_reason: motivo || null
        });
        if (error) throw error;
    }

    function abrirSuspender(businessId) {
        const empresa = empresaPorId(businessId);
        if (!empresa) { toast("Empresa não encontrada. Atualize a lista.", "erro"); return; }
        if (suspensa(empresa)) { toast("Esta empresa já está suspensa.", "atencao"); return; }

        const corpo = "" +
            '<p class="dica">A empresa <b>' + esc(empresa.nome || "(sem nome)") + "</b> ficará temporariamente " +
            "sem acesso ao cardápio público e ao gerenciamento enquanto estiver suspensa.</p>" +
            '<div class="aviso-info">Nenhum produto, configuração ou dado será apagado.</div>' +
            '<div class="campo">' +
            '<label for="motivo-suspensao">Motivo da suspensão <span class="opcional">OPCIONAL</span></label>' +
            '<input id="motivo-suspensao" type="text" maxlength="180" autocomplete="off" placeholder="Pagamento em atraso">' +
            '<p class="dica" style="margin-top:6px">Fica visível só aqui, na administração da plataforma.</p>' +
            "</div>" +
            '<p class="aviso-form" id="erro-form" hidden></p>';

        const rodape =
            '<button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>' +
            '<button type="button" class="btn btn-principal" id="btn-suspender">Suspender empresa</button>';

        abrirFolha("Suspender empresa", corpo, rodape);

        $("#btn-suspender").addEventListener("click", async function () {
            const btn = this;
            if (btn.disabled) return;
            limparErroForm();
            const motivo = $("#motivo-suspensao").value.trim();

            ocupado(btn, true);
            try {
                await definirStatus(empresa.id, "suspended", motivo);
                fecharFolha();
                toast("Empresa suspensa.");
                await recarregar();
            } catch (e) {
                /* nada de estado local fingindo que deu certo: o modal fica
                   aberto, com o motivo preservado, para tentar de novo */
                console.error("[superadmin]", e);
                ocupado(btn, false);
                erroNoForm(mensagemErro(e));
            }
        });

        setTimeout(function () { const c = $("#motivo-suspensao"); if (c) c.focus(); }, 320);
    }

    function abrirReativar(businessId) {
        const empresa = empresaPorId(businessId);
        if (!empresa) { toast("Empresa não encontrada. Atualize a lista.", "erro"); return; }
        if (!suspensa(empresa)) { toast("Esta empresa já está ativa.", "atencao"); return; }

        const corpo =
            '<p class="dica">Reativar <b>' + esc(empresa.nome || "(sem nome)") + "</b>?</p>" +
            '<div class="aviso-info">O cardápio e o painel administrativo voltarão a funcionar. ' +
            "Todos os dados existentes serão mantidos.</div>" +
            (empresa.motivoSuspensao
                ? '<p class="dica" style="margin-top:10px">Motivo registrado na suspensão: <b>' +
                esc(empresa.motivoSuspensao) + "</b></p>"
                : "") +
            '<p class="aviso-form" id="erro-form" hidden></p>';

        const rodape =
            '<button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>' +
            '<button type="button" class="btn btn-principal" id="btn-reativar">Reativar empresa</button>';

        abrirFolha("Reativar empresa", corpo, rodape);

        $("#btn-reativar").addEventListener("click", async function () {
            const btn = this;
            if (btn.disabled) return;
            limparErroForm();
            ocupado(btn, true);
            try {
                /* motivo vai NULO: reativar limpa o registro da suspensão */
                await definirStatus(empresa.id, "active", null);
                fecharFolha();
                toast("Empresa reativada.");
                await recarregar();
            } catch (e) {
                console.error("[superadmin]", e);
                ocupado(btn, false);
                erroNoForm(mensagemErro(e));
            }
        });
    }

    /* Exclusão definitiva. O botão nasce desabilitado e só libera quando o
       nome digitado é EXATAMENTE igual ao da empresa — a mesma string que
       vai como p_confirm_name, para a RPC conferir do lado de lá também. */
    function abrirExcluir(businessId) {
        const empresa = empresaPorId(businessId);
        if (!empresa) { toast("Empresa não encontrada. Atualize a lista.", "erro"); return; }
        const nome = empresa.nome || "";

        const corpo = "" +
            '<p class="dica">Você está prestes a excluir <b>' + esc(nome || "(sem nome)") + "</b>.</p>" +
            '<div class="aviso-perigo">' +
            "<b>Esta ação não poderá ser desfeita.</b><br>" +
            "Produtos, categorias, domínios, configurações e vínculos relacionados à empresa " +
            "poderão ser removidos pelo banco.<br><br>" +
            "A conta do usuário no Supabase Auth não será apagada automaticamente." +
            "</div>" +
            '<div class="campo">' +
            '<label for="confirmar-nome">Para confirmar, digite exatamente:</label>' +
            '<span class="nome-confirmar">' + esc(nome || "(sem nome)") + "</span>" +
            '<input id="confirmar-nome" type="text" autocomplete="off" autocapitalize="none" ' +
            'autocorrect="off" spellcheck="false" placeholder="Digite o nome da empresa" style="margin-top:10px">' +
            "</div>" +
            '<p class="aviso-form" id="erro-form" hidden></p>';

        const rodape =
            '<button type="button" class="btn btn-secundario" data-fechar>Cancelar</button>' +
            '<button type="button" class="btn btn-perigo" id="btn-excluir" disabled>Excluir definitivamente</button>';

        abrirFolha("Excluir empresa definitivamente", corpo, rodape);

        const campo = $("#confirmar-nome");
        const btn = $("#btn-excluir");

        /* comparação exata: sem minúsculas, sem acento removido, sem "quase" */
        const confere = () => { btn.disabled = campo.value.trim() !== nome; };
        campo.addEventListener("input", confere);
        confere();

        btn.addEventListener("click", async function () {
            if (btn.disabled) return;
            limparErroForm();
            const digitado = campo.value.trim();
            if (digitado !== nome) { confere(); return; }

            ocupado(btn, true);
            try {
                const { error } = await sb.rpc("superadmin_delete_business", {
                    p_business_id: empresa.id,
                    p_confirm_name: digitado
                });
                if (error) throw error;
                fecharFolha();
                toast("Empresa excluída.");
                await recarregar();
            } catch (e) {
                console.error("[superadmin]", e);
                ocupado(btn, false);
                confere();
                erroNoForm(mensagemErro(e));
            }
        });

        setTimeout(function () { if (campo) campo.focus(); }, 320);
    }

    /* ---------- 8.2 MENU "MAIS OPÇÕES" ---------------------------------
       Um menu por vez, preso ao botão que o abriu, fechado por clique fora,
       Esc ou rolagem. É onde a exclusão vive. */
    let menuAberto = null;

    function fecharMenu() {
        if (!menuAberto) return;
        const { el, botao } = menuAberto;
        menuAberto = null;
        if (el && el.parentNode) el.parentNode.removeChild(el);
        if (botao) botao.setAttribute("aria-expanded", "false");
    }

    function abrirMenu(botao, businessId) {
        const empresa = empresaPorId(businessId);
        if (!empresa) { toast("Empresa não encontrada. Atualize a lista.", "erro"); return; }
        const jaEra = menuAberto && menuAberto.botao === botao;
        fecharMenu();
        if (jaEra) return;                      // clicar de novo fecha

        const el = document.createElement("div");
        el.className = "menu-acoes";
        el.setAttribute("role", "menu");
        el.innerHTML =
            '<button type="button" role="menuitem" data-menu-status="' + esc(empresa.id) + '">' +
            (suspensa(empresa) ? "Reativar empresa" : "Suspender empresa") +
            "<small>" + (suspensa(empresa)
                ? "Volta a funcionar imediatamente"
                : "Tira do ar sem apagar nada") + "</small></button>" +
            '<button type="button" role="menuitem" class="perigo" data-menu-excluir="' + esc(empresa.id) + '">' +
            "Excluir empresa<small>Definitivo, sem desfazer</small></button>";

        document.body.appendChild(el);
        const r = botao.getBoundingClientRect();
        const largura = el.offsetWidth;
        /* ancora à direita do botão, e sobe se não houver espaço abaixo */
        const esquerda = Math.max(8, Math.min(window.innerWidth - largura - 8, r.right - largura));
        const abaixo = r.bottom + 6 + el.offsetHeight <= window.innerHeight - 8;
        el.style.left = (esquerda + window.scrollX) + "px";
        el.style.top = ((abaixo ? r.bottom + 6 : r.top - 6 - el.offsetHeight) + window.scrollY) + "px";

        botao.setAttribute("aria-expanded", "true");
        menuAberto = { el: el, botao: botao };
    }

    /* ---------- 9. EVENTOS E INÍCIO ------------------------------------ */

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
        $("#btn-sair-restrito").addEventListener("click", sair);
        $("#btn-ir-painel").setAttribute("href", CAMINHO_PAINEL);
        $("#btn-tentar-de-novo").addEventListener("click", async function () {
            ocupado(this, true);
            try { await abrirComSessao(); } finally { ocupado(this, false); }
        });

        document.addEventListener("click", function (ev) {
            const aba = ev.target.closest("[data-aba]");
            if (aba) { irPara(aba.dataset.aba); return; }
            if (ev.target.closest("[data-fechar]")) { fecharFolha(); return; }
            if (ev.target.closest("[data-novo-cliente]")) { abrirNovoCliente(); return; }
            if (ev.target.closest("[data-recarregar]")) { recarregar(); return; }
            if (ev.target.closest("[data-fechar-aviso]")) { estado.aviso = null; render(); return; }
            const conv = ev.target.closest("[data-convidar]");
            if (conv) { abrirConvite(conv.dataset.convidar); return; }

            /* status */
            const sus = ev.target.closest("[data-suspender]");
            if (sus) { fecharMenu(); abrirSuspender(sus.dataset.suspender); return; }
            const rea = ev.target.closest("[data-reativar]");
            if (rea) { fecharMenu(); abrirReativar(rea.dataset.reativar); return; }

            /* mais opções */
            const mais = ev.target.closest("[data-mais]");
            if (mais) { abrirMenu(mais, mais.dataset.mais); return; }
            const mStatus = ev.target.closest("[data-menu-status]");
            if (mStatus) {
                const id = mStatus.dataset.menuStatus;
                fecharMenu();
                const alvo = empresaPorId(id);
                if (alvo && suspensa(alvo)) abrirReativar(id); else abrirSuspender(id);
                return;
            }
            const mExcluir = ev.target.closest("[data-menu-excluir]");
            if (mExcluir) { const id = mExcluir.dataset.menuExcluir; fecharMenu(); abrirExcluir(id); return; }

            /* clique em qualquer outro lugar fecha o menu aberto */
            fecharMenu();
        });

        /* o menu é posicionado em coordenadas de tela: rolar a página o
           deixaria solto no ar, então ele fecha */
        window.addEventListener("scroll", fecharMenu, true);
        window.addEventListener("resize", fecharMenu);

        /* A busca redesenha só a lista: redesenhar a tela inteira tiraria o
           foco do campo a cada tecla digitada. */
        document.addEventListener("input", function (ev) {
            if (ev.target && ev.target.id === "campo-busca") {
                estado.busca = ev.target.value;
                renderListaEmpresas();
            }
        });

        $("#cortina").addEventListener("click", fecharFolha);
        document.addEventListener("keydown", function (ev) {
            if (ev.key !== "Escape") return;
            if (menuAberto) { fecharMenu(); return; }
            if (!$("#folha").hidden) fecharFolha();
        });
    }

    async function iniciar() {
        ligarEventos();
        limparUrl();

        /* Registrado antes de qualquer desvio: se a sessão cair ou expirar
           enquanto a tela está aberta, a pessoa volta ao login em vez de
           ficar olhando para uma lista que não atualiza mais. */
        sb.auth.onAuthStateChange(function (evento, sessao) {
            if (evento === "SIGNED_OUT") {
                estado.usuario = null;
                estado.empresas = [];
                mostrarTela("login");
            } else if (sessao && sessao.user) {
                estado.usuario = sessao.user;
                const el = $("#topo-email");
                if (el) el.textContent = sessao.user.email || "";
            }
        });

        try {
            const { data } = await sb.auth.getSession();
            const sessao = data && data.session;
            if (!sessao) { mostrarTela("login"); return; }
            estado.usuario = sessao.user;
            await abrirComSessao();
        } catch (e) {
            console.error("[superadmin]", e);
            mostrarTela("login");
            const erro = $("#erro-login");
            erro.textContent = mensagemErro(e);
            erro.hidden = false;
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", iniciar);
    } else {
        iniciar();
    }
})();