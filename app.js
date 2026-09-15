/* =====================================================================
   ESTÂNCIA TREZE PIZZARIA — APLICAÇÃO DO CARDÁPIO
   Depende de menu-data.js (CONFIG, OPCOES, CATEGORIAS, MENU)

   Seções:
   1. Utilidades          6. Sheets (modais)
   2. Ilustrações         7. Produto
   3. Estado / carrinho   8. Carrinho
   4. Horário da loja     9. Finalização + WhatsApp
   5. Cardápio            10. Inicialização
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- 1. UTILIDADES ----------------------------------------- */
  const $  = (s, ctx) => (ctx || document).querySelector(s);
  const $$ = (s, ctx) => Array.from((ctx || document).querySelectorAll(s));

  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const money = (v) => brl.format(v || 0);

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const semAcento = (s) => String(s).normalize("NFD").split("").filter(function(c){var k=c.charCodeAt(0);return k<0x300||k>0x36f;}).join("").toLowerCase();


  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rngFrom(seed) {
    let t = seed + 0x6D2B79F5;
    return function () {
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const produtoPorId = (id) => MENU.find((p) => p.id === id);
  const catPorId = (id) => CATEGORIAS.find((c) => c.id === id);

  /* Opções de UM produto. Produto vindo do Supabase traz as suas em
     p.opcoes; produto do cardápio local cai no objeto global OPCOES.
     É o único lugar do app que decide isso. */
  function opcoesDo(p) {
    if (p.opcoes) return p.opcoes;
    return {
      tamanhos: (OPCOES.tamanhos || [])
        .map((t) => ({ id: t.id, nome: t.nome, detalhe: t.detalhe,
                       preco: (p.precos || {})[t.id], precoNormal: (p.precos || {})[t.id], emPromocao: false }))
        .filter((t) => typeof t.preco === "number"),
      bordas: (OPCOES.bordas || []).map((b) => ({ id: b.id, nome: b.nome, preco: b.preco })),
      adicionais: (OPCOES.adicionais || []).map((a) => ({ id: a.id, nome: a.nome, preco: a.preco }))
    };
  }

  /* Preço inicial mostrado no card: o menor entre os tamanhos, já
     resolvido (promoção incluída) e com o preço normal para riscar. */
  function precoInicial(p) {
    const tamanhos = opcoesDo(p).tamanhos;
    if (tamanhos.length) {
      let melhor = tamanhos[0];
      tamanhos.forEach(function (t) { if (t.preco < melhor.preco) melhor = t; });
      return { preco: melhor.preco,
               normal: melhor.precoNormal != null ? melhor.precoNormal : melhor.preco,
               promo: !!melhor.emPromocao };
    }
    return { preco: p.preco,
             normal: p.precoNormal != null ? p.precoNormal : p.preco,
             promo: !!p.emPromocao };
  }

  function precoBase(p) { return precoInicial(p).preco; }

  /* Preço normal riscado + preço vigente. */
  function precoHTML(info, legenda) {
    let h = legenda || "";
    if (info.promo) h += '<s class="preco-antes dinheiro">' + money(info.normal) + "</s> ";
    return h + '<span class="' + (info.promo ? "preco-promo " : "") + 'dinheiro">' + money(info.preco) + "</span>";
  }

  const temTamanhos = (p) => opcoesDo(p).tamanhos.length > 0;
  const indisponivel = (p) => p.disponivel === false;

  /* ---------- 2. ILUSTRAÇÕES (usadas enquanto não há fotos) ---------- */
  let uidArte = 0;

  /* Desenha a ilustração do produto e, por cima dela, a foto (quando houver).
     Se a foto não carregar, a ilustração continua no lugar — nunca sobra
     espaço quebrado. Trocar a foto = trocar o campo "imagem" em menu-data.js. */
  function arte(p) {
    const a = p.arte || { tipo: "pizza", massa: "#E9BB6A", base: "#E0C38B", itens: [] };
    const uid = "a" + (uidArte++);
    const corpo = a.tipo === "pizza" ? pizzaSVG(a, hash(p.id), uid)
                : a.tipo === "lata"  ? bebidaSVG(a, uid, "lata")
                :                      bebidaSVG(a, uid, "garrafa");
    let h = '<svg viewBox="0 0 200 200" role="img" aria-label="Ilustração de ' + esc(p.nome) +
            '" preserveAspectRatio="xMidYMid slice">' + corpo + "</svg>";
    if (p.imagem) {
      h += '<img class="foto-real" src="' + esc(p.imagem) + '" alt="' + esc(p.nome) +
           '" loading="lazy" decoding="async">';
    }
    return h;
  }

  /* Liga o fade-in das fotos e remove as que falharem. */
  function prepararFotos(raiz) {
    $$("img.foto-real", raiz || document).forEach(function (img) {
      if (img.dataset.pronto) return;
      img.dataset.pronto = "1";
      if (img.complete) {
        if (img.naturalWidth > 0) img.classList.add("carregada");
        else img.remove();
        return;
      }
      img.addEventListener("load", function () { img.classList.add("carregada"); });
      img.addEventListener("error", function () { img.remove(); });
    });
  }

  function fundoDefs(uid, c1, c2) {
    return '<defs><radialGradient id="bg' + uid + '" cx="30%" cy="20%" r="95%">' +
           '<stop offset="0%" stop-color="' + c1 + '"/><stop offset="100%" stop-color="' + c2 + '"/>' +
           "</radialGradient></defs>";
  }

  function pizzaSVG(a, seed, uid) {
    const r = rngFrom(seed);
    let s = fundoDefs(uid, "#F7EEDD", "#E3CDA9");
    s += '<defs><radialGradient id="m' + uid + '" cx="38%" cy="32%" r="80%">' +
         '<stop offset="0%" stop-color="' + clarear(a.massa, 18) + '"/>' +
         '<stop offset="100%" stop-color="' + a.massa + '"/></radialGradient></defs>';
    s += '<rect width="200" height="200" fill="url(#bg' + uid + ')"/>';
    s += '<circle cx="100" cy="104" r="84" fill="rgba(90,50,20,.18)"/>';
    s += '<circle cx="100" cy="100" r="84" fill="url(#m' + uid + ')"/>';
    s += '<circle cx="100" cy="100" r="84" fill="none" stroke="rgba(120,70,25,.22)" stroke-width="2"/>';
    s += '<circle cx="100" cy="100" r="70" fill="' + a.base + '"/>';
    s += '<circle cx="100" cy="100" r="70" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="3"/>';

    (a.itens || []).forEach(function (it) {
      for (let i = 0; i < it.n; i++) {
        const ang = r() * Math.PI * 2;
        const rad = 62 * Math.sqrt(r());
        const x = 100 + Math.cos(ang) * rad;
        const y = 100 + Math.sin(ang) * rad;
        const g = Math.round(r() * 360);
        const t = it.tam;
        const stroke = it.borda ? ' stroke="' + it.borda + '" stroke-width="1.5"' : "";
        if (it.forma === "circulo") {
          s += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (t / 2) + '" fill="' + it.cor + '"' + stroke + "/>";
        } else if (it.forma === "anel") {
          s += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (t / 2) +
               '" fill="none" stroke="' + it.cor + '" stroke-width="2.4" opacity=".95"/>';
        } else if (it.forma === "quadrado") {
          s += '<rect x="' + (x - t / 2).toFixed(1) + '" y="' + (y - t / 2).toFixed(1) + '" width="' + t + '" height="' + t +
               '" rx="2.5" fill="' + it.cor + '"' + stroke + ' transform="rotate(' + g + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')"/>';
        } else if (it.forma === "gota") {
          s += '<ellipse cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" rx="' + (t / 2) + '" ry="' + (t / 2.7).toFixed(1) +
               '" fill="' + it.cor + '"' + stroke + ' transform="rotate(' + g + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')"/>';
        } else if (it.forma === "folha") {
          const k = (t / 12).toFixed(2);
          s += '<path d="M0,-6 C4.2,-2.6 4.2,2.6 0,6 C-4.2,2.6 -4.2,-2.6 0,-6 Z" fill="' + it.cor +
               '" transform="translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') rotate(' + g + ') scale(' + k + ')"/>';
        } else if (it.forma === "raspa") {
          s += '<rect x="' + (x - t / 2).toFixed(1) + '" y="' + (y - 1).toFixed(1) + '" width="' + t + '" height="2" rx="1" fill="' + it.cor +
               '" transform="rotate(' + g + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')" opacity=".9"/>';
        } else if (it.forma === "fio") {
          const dx = t, dy = t * 0.5;
          s += '<path d="M' + (x - dx / 2).toFixed(1) + ',' + y.toFixed(1) + ' q' + (dx / 2).toFixed(1) + ',' + (-dy).toFixed(1) +
               ' ' + dx.toFixed(1) + ',0" fill="none" stroke="' + it.cor + '" stroke-width="3" stroke-linecap="round"' +
               ' transform="rotate(' + g + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')" opacity=".92"/>';
        }
      }
    });
    /* brilho suave */
    s += '<ellipse cx="72" cy="62" rx="42" ry="26" fill="rgba(255,255,255,.10)" transform="rotate(-24 72 62)"/>';
    return s;
  }

  function bebidaSVG(a, uid, forma) {
    let s = fundoDefs(uid, clarear(a.cor, 48), clarear(a.cor2 || a.cor, 10));
    s += '<rect width="200" height="200" fill="url(#bg' + uid + ')"/>';
    s += '<ellipse cx="100" cy="168" rx="46" ry="10" fill="rgba(0,0,0,.18)"/>';
    if (forma === "lata") {
      s += '<rect x="74" y="46" width="52" height="112" rx="13" fill="' + a.cor + '"/>';
      s += '<rect x="74" y="46" width="52" height="112" rx="13" fill="none" stroke="rgba(0,0,0,.18)"/>';
      s += '<rect x="74" y="46" width="14" height="112" rx="7" fill="rgba(255,255,255,.22)"/>';
      s += '<rect x="74" y="92" width="52" height="22" fill="rgba(255,255,255,.85)"/>';
      s += '<ellipse cx="100" cy="47" rx="26" ry="7" fill="#CFCFD4"/>';
      s += '<ellipse cx="100" cy="45" rx="20" ry="4.5" fill="#EAEAEE"/>';
    } else {
      s += '<path d="M86,34 h28 v14 c0,7 12,14 12,26 v74 c0,8 -6,14 -14,14 h-24 c-8,0 -14,-6 -14,-14 v-74 c0,-12 12,-19 12,-26 z" fill="' + a.cor + '" opacity=".92"/>';
      s += '<path d="M86,34 h10 v14 c0,7 -8,14 -8,26 v88 h-4 c-8,0 -14,-6 -14,-14 v-74 c0,-12 12,-19 12,-26 z" fill="rgba(255,255,255,.24)"/>';
      s += '<rect x="72" y="108" width="56" height="30" fill="rgba(255,255,255,.88)"/>';
      s += '<rect x="84" y="24" width="32" height="14" rx="4" fill="' + (a.cor2 || "#3A2018") + '"/>';
    }
    return s;
  }

  function clarear(hex, pct) {
    const n = parseInt(String(hex).replace("#", ""), 16);
    const mix = (c) => Math.round(c + (255 - c) * (pct / 100));
    const rr = mix((n >> 16) & 255), gg = mix((n >> 8) & 255), bb = mix(n & 255);
    return "#" + ((1 << 24) + (rr << 16) + (gg << 8) + bb).toString(16).slice(1);
  }

  /* ---------- 3. ESTADO / CARRINHO ---------------------------------- */
  const CHAVE = "estancia13.carrinho.v1";
  let carrinho = [];
  let bloqueado = false;        // true quando o cardápio não pôde ser carregado
  let avisosCarrinho = [];      // mensagens da revalidação, mostradas no carrinho

  function carregarCarrinho() {
    try {
      const bruto = localStorage.getItem(CHAVE);
      const dados = bruto ? JSON.parse(bruto) : [];
      carrinho = Array.isArray(dados) ? dados.filter((i) => i && i.produtoId && i.qtd > 0) : [];
    } catch (e) { carrinho = []; }
  }
  function salvarCarrinho() {
    try { localStorage.setItem(CHAVE, JSON.stringify(carrinho)); } catch (e) {}
  }

  const unitario = (i) => i.precoBase + i.precoExtras;
  function totais() {
    let sub = 0, extras = 0, itens = 0;
    carrinho.forEach(function (i) {
      sub += i.precoBase * i.qtd;
      extras += i.precoExtras * i.qtd;
      itens += i.qtd;
    });
    return { subtotal: sub, extras: extras, total: sub + extras, itens: itens };
  }

  function assinatura(i) {
    return [i.produtoId, i.tamanhoId || "", i.bordaId || "",
            (i.adicionais || []).map((a) => a.id).sort().join(","),
            (i.obs || "").trim().toLowerCase()].join("|");
  }

  function adicionarItem(item) {
    const igual = carrinho.find((i) => assinatura(i) === assinatura(item));
    if (igual) igual.qtd += item.qtd;
    else carrinho.push(Object.assign({ uid: "i" + Date.now() + Math.round(Math.random() * 999) }, item));
    salvarCarrinho();
    atualizarCarrinho();
  }

  function mudarQtd(uid, delta) {
    const i = carrinho.find((x) => x.uid === uid);
    if (!i) return;
    i.qtd += delta;
    if (i.qtd <= 0) carrinho = carrinho.filter((x) => x.uid !== uid);
    salvarCarrinho();
    atualizarCarrinho();
    renderCarrinho();
  }
  function removerItem(uid) {
    const i = carrinho.find((x) => x.uid === uid);
    carrinho = carrinho.filter((x) => x.uid !== uid);
    salvarCarrinho();
    atualizarCarrinho();
    renderCarrinho();
    if (i) toast("Removido: " + i.nome);
  }
  function limparCarrinho() {
    carrinho = [];
    salvarCarrinho();
    atualizarCarrinho();
    renderCarrinho();
  }

  function atualizarCarrinho() {
    const t = totais();
    const barra = $("#barra-carrinho");
    $("#barra-contador").textContent = t.itens;
    $("#barra-itens").textContent = t.itens === 1 ? "item" : "itens";
    $("#barra-valor").textContent = money(t.total);
    barra.classList.toggle("visivel", t.itens > 0 && !bloqueado);
    $("#carrinho-badge").textContent = t.itens;
    $("#carrinho-badge").hidden = t.itens === 0;
  }

  /* ---------- 3.1 EMPRESA (nome e WhatsApp) -------------------------
     Fonte oficial: a linha de `businesses`, que chega junto do cardápio
     em carregar() — sem consulta extra. Nome e número NÃO existem mais
     escritos no código: menu-data.js só entra quando DATA_SOURCE não é
     "supabase" (modo de desenvolvimento).
     ------------------------------------------------------------------ */
  let EMPRESA = null;

  /* Espelho do que estiver em CONFIG — usado só no modo local. */
  function empresaLocal() {
    const w = (window.Whats && window.Whats.normalizar)
      ? window.Whats.normalizar(CONFIG.whatsapp)
      : { ok: false, numero: "", exibicao: "", motivo: "" };
    return {
      id: null,
      slug: (typeof DEV_BUSINESS_SLUG !== "undefined") ? DEV_BUSINESS_SLUG : "",
      nome: CONFIG.nomeCompleto || "",
      whatsapp: w.ok ? w.numero : "",
      whatsappExibicao: w.ok ? w.exibicao : "",
      whatsappValido: !!w.ok,
      whatsappMotivo: w.ok ? "" : (w.motivo || ""),
      descricao: "",
      instagram: "",
      instagramUrl: "",
      logoPath: "", faviconPath: "", logoUrl: "", faviconUrl: "",
      endereco: {}
    };
  }

  const nomeEmpresa   = () => (EMPRESA && EMPRESA.nome) || CONFIG.nomeCompleto || "";
  const numeroWhats   = () => (EMPRESA && EMPRESA.whatsappValido) ? EMPRESA.whatsapp : "";
  const SEM_WHATS = "Não foi possível carregar o WhatsApp do estabelecimento. " +
                    "Tente novamente em alguns instantes.";

  /* Passa os dados da empresa para os textos da página. CONFIG vira um
     espelho do banco — nada aqui reescreve o banco. */
  function aplicarEmpresa(e) {
    if (!e) return;
    if (e.nome) { CONFIG.nomeCompleto = e.nome; CONFIG.nome = e.nome; }
    CONFIG.whatsapp = e.whatsapp || "";
    CONFIG.whatsappExibicao = e.whatsappExibicao || "";
    /* "Botucatu — SP" para a linha do topo; vazio se não houver cadastro */
    CONFIG.cidade = enderecoDa(e).resumoCidade;
    preencherTextos();
    renderMarca();
    renderLogo(e);
    renderFavicon(e);
    renderPerfilEmpresa(e);
    if (e.nome) document.title = e.nome;
  }

  /* -------------------------------------------------------------------
     LOGO E FAVICON — só trocam a origem da imagem. Nenhuma medida, nenhum
     espaçamento e nenhum posicionamento do cabeçalho muda: a logo entra
     DENTRO do mesmo selo do cabeçalho. Nada aqui é requisito para o
     cardápio funcionar: se a imagem não carregar, o site segue igual.

     O selo não traz mais uma marca escrita no código ("13"): o mesmo
     arquivo atende empresas diferentes. Sem logo cadastrada, ele mostra
     as iniciais do nome que veio do banco — e fica VAZIO enquanto a
     empresa não foi resolvida, para nunca piscar a marca de outra casa.
     ------------------------------------------------------------------- */
  function iniciaisDe(nome) {
    const palavras = String(nome || "").trim().split(/\s+/).filter(function (p) {
      return p && !/^(de|da|do|das|dos|e)$/i.test(p);
    });
    if (!palavras.length) return "";
    const letras = palavras.slice(0, 2).map(function (p) {
      return Array.from(p)[0] || "";
    }).join("");
    return letras.toLocaleUpperCase("pt-BR");
  }

  function seloPadrao() {
    const selo = $("#marca-selo");
    if (!selo) return;
    selo.textContent = iniciaisDe(nomeEmpresa());
    selo.classList.remove("com-logo");
    selo.setAttribute("aria-hidden", "true");
  }

  function renderLogo(e) {
    const selo = $("#marca-selo");
    if (!selo) return;
    const url = (e && e.logoUrl) || "";
    if (!url) { seloPadrao(); return; }

    /* A imagem é carregada fora da página primeiro: se der erro (path
       inválido, Storage fora do ar), o selo "13" nem chega a piscar e
       nunca aparece ícone quebrado. */
    const img = new Image();
    img.className = "marca-logo";
    img.alt = nomeEmpresa();               // nome vem do banco, não do código
    img.decoding = "async";
    img.onload = function () {
      selo.textContent = "";
      selo.appendChild(img);
      selo.classList.add("com-logo");
      selo.removeAttribute("aria-hidden");
    };
    img.onerror = function () {
      console.warn("[cardápio] logo não pôde ser carregada — mantendo o selo padrão.");
      seloPadrao();
    };
    img.src = url;
  }

  function renderFavicon(e) {
    const url = (e && e.faviconUrl) || "";
    if (!url) return;                      // sem cadastro: mantém o que a página já tem

    const teste = new Image();
    teste.onload = function () {
      let link = document.querySelector('link[rel="icon"]');
      if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
      }
      link.type = "image/png";
      link.href = url;
    };
    teste.onerror = function () {
      console.warn("[cardápio] favicon não pôde ser carregado — mantendo o padrão.");
    };
    teste.src = url;
  }

  /* O formatador mora em data.js — aqui só usamos o resultado. */
  function enderecoDa(e) {
    const bruto = (e && e.endereco) || {};
    const f = (window.Cardapio && window.Cardapio.formatarEndereco)
      ? window.Cardapio.formatarEndereco(bruto)
      : { linhas: [], resumo: "", vazio: true, podeMapear: false, mapaUrl: "" };
    f.resumoCidade = [String(bruto.cidade || "").trim(),
                      String(bruto.estado || "").trim().toUpperCase()]
                     .filter(Boolean).join(" — ");
    return f;
  }

  /* -------------------------------------------------------------------
     PERFIL PÚBLICO: descrição, Instagram e endereço do ESTABELECIMENTO.
     Cada pedaço some por completo quando o campo está vazio — nunca fica
     rótulo solto, buraco no layout ou aviso de "não cadastrado".
     ------------------------------------------------------------------- */
  function renderPerfilEmpresa(e) {
    e = e || EMPRESA || {};

    /* descrição */
    const desc = $("#sobre-descricao");
    if (desc) {
      const t = String(e.descricao || "").trim();
      desc.textContent = t;
      desc.hidden = !t;
    }

    /* Instagram — a URL é montada aqui, não guardada no banco */
    const url = e.instagramUrl || "";
    $$("[data-instagram]").forEach(function (el) {
      const rotulo = $(".rotulo-insta", el);
      if (!url) { el.removeAttribute("href"); el.hidden = true; return; }
      el.hidden = false;
      el.href = url;
      if (rotulo) rotulo.textContent = el.closest("#rodape-instagram") ? "@" + e.instagram : "Instagram";
    });
    const linhaInsta = $("#rodape-instagram");
    if (linhaInsta) linhaInsta.hidden = !url;

    /* endereço */
    const end = enderecoDa(e);
    const bloco = $("#bloco-endereco");
    const lista = $("#endereco-linhas");
    if (bloco && lista) {
      bloco.hidden = end.vazio;
      lista.innerHTML = end.linhas.map((l) => "<span>" + esc(l) + "</span>").join("");
    }
    const mapa = $("#ver-mapa");
    if (mapa) {
      mapa.hidden = !end.podeMapear;
      if (end.podeMapear) mapa.href = end.mapaUrl; else mapa.removeAttribute("href");
    }
    const rodape = $("#rodape-endereco");
    if (rodape) {
      rodape.hidden = !end.resumo;
      const alvo = $("span", rodape);
      if (alvo) alvo.textContent = end.resumo;
    }
  }

  /* Logotipo em texto do cabeçalho: a primeira palavra fica grande e o
     resto vai para o <span> dourado — mesma arte de sempre, agora com o
     nome vindo do banco. O selo "13" é imagem/marca e não é tocado. */
  function renderMarca() {
    const el = $("#marca-nome");
    if (!el) return;
    const nome = nomeEmpresa().trim();
    if (!nome) return;
    const corte = nome.indexOf(" ");
    const inicio = corte > 0 ? nome.slice(0, corte) : nome;
    const resto  = corte > 0 ? nome.slice(corte + 1) : "";
    el.innerHTML = esc(inicio) + (resto ? "<span>" + esc(resto) + "</span>" : "");
  }

  /* ---------- 4. HORÁRIO DA LOJA ------------------------------------
     Os horários vêm de business_hours / business_hours_settings, e a
     hora vem da RPC get_server_now() — nunca do relógio do aparelho.
     Quem decide "está aberto?" é window.Cardapio.calcularStatusFuncionamento;
     aqui só exibimos o resultado e decidimos o que bloquear.
     ------------------------------------------------------------------ */
  const DIAS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
  const DIAS_CURTO = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

  let HORARIOS = null;            // null = ainda não carregado

  /* Fallback de DESENVOLVIMENTO: converte CONFIG.horarios ([abre, fecha]
     em horas) para o mesmo formato do banco. Só entra quando
     DATA_SOURCE não é "supabase". */
  function horariosLocais() {
    const dias = [];
    for (let i = 0; i < 7; i++) {
      const f = CONFIG.horarios ? CONFIG.horarios[i] : null;
      dias.push(f
        ? { dia: i, fechado: false, abre: Math.round(f[0] * 60), fecha: Math.round(f[1] * 60) }
        : { dia: i, fechado: true, abre: null, fecha: null });
    }
    /* no modo local o relógio do aparelho É a referência declarada */
    return { erro: false, timezone: CONFIG.timezone || "America/Sao_Paulo",
             aceitarPedidosFechado: true, dias: dias, relogioConfiavel: true };
  }

  const horaTexto = (min) =>
    (window.Cardapio && window.Cardapio.formatarHora)
      ? window.Cardapio.formatarHora(min)
      : String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");

  const DESCONHECIDO = { erro: true, aberto: false, texto: "Horário indisponível",
                         detalhe: "", proximaAbertura: null, agora: null };

  function statusLoja() {
    if (!HORARIOS || !window.Cardapio || !window.Cardapio.calcularStatusFuncionamento) return DESCONHECIDO;
    return window.Cardapio.calcularStatusFuncionamento(HORARIOS);
  }

  function renderStatus() {
    const el = $("#status");
    if (!el) return;
    if (!HORARIOS) { el.hidden = true; return; }   // nada a afirmar enquanto carrega
    const s = statusLoja();
    el.hidden = false;
    el.classList.toggle("esta-fechado", !s.aberto);
    el.classList.toggle("status-incerto", !!s.erro);
    el.innerHTML = '<span class="ponto"></span><span>' + esc(s.texto) + "</span>" +
                   (s.detalhe ? '<small>· ' + esc(s.detalhe) + "</small>" : "");
  }

  function renderHorarios() {
    const lista = $("#horarios-lista");
    const resumoEl = $("#horario-resumo");
    const itemResumo = resumoEl ? resumoEl.closest(".info-item") : null;

    if (!HORARIOS || HORARIOS.erro) {
      if (lista) lista.innerHTML = '<p class="horario-indisponivel">Horário indisponível no momento.</p>';
      if (resumoEl) resumoEl.textContent = "";
      if (itemResumo) itemResumo.hidden = true;
      return;
    }

    const s = statusLoja();
    const hoje = s.agora ? s.agora.dia : -1;
    const abertos = HORARIOS.dias.filter((d) => !d.fechado).map(function (d) {
      return { i: d.dia, txt: horaTexto(d.abre) + " às " + horaTexto(d.fecha),
               vira: d.fecha <= d.abre };
    });
    const fechados = HORARIOS.dias.filter((d) => d.fechado).map((d) => DIAS_CURTO[d.dia]);

    /* resumo curto no cabeçalho: "Quinta, sexta e sábado — 19:00 às 23:00" */
    if (abertos.length) {
      const nomes = abertos.map((d) => DIAS[d.i].toLowerCase());
      const texto = nomes.length > 1
        ? nomes.slice(0, -1).join(", ") + " e " + nomes[nomes.length - 1]
        : nomes[0];
      const mesmoHorario = abertos.every((d) => d.txt === abertos[0].txt);
      if (resumoEl) {
        resumoEl.textContent = texto.charAt(0).toUpperCase() + texto.slice(1) +
          (mesmoHorario ? " — " + abertos[0].txt : "");
      }
      if (itemResumo) itemResumo.hidden = false;
    } else {
      if (resumoEl) resumoEl.textContent = "";
      if (itemResumo) itemResumo.hidden = true;
    }

    if (!lista) return;
    lista.innerHTML = (abertos.length
      ? abertos.map(function (d) {
          return '<div class="linha-horario' + (d.i === hoje ? " hoje" : "") + '">' +
                 "<span>" + DIAS_CURTO[d.i] + "</span><span>" + esc(d.txt) +
                 (d.vira ? '<small class="vira-dia" title="Fecha no dia seguinte"> +1</small>' : "") +
                 "</span></div>";
        }).join("")
      : "") +
      (fechados.length ? '<div class="linha-horario folga"><span>' + fechados.join(", ") +
        "</span><span>Fechado</span></div>" : "");
  }

  /* -------------------------------------------------------------------
     BLOQUEIO POR HORÁRIO
     Ponto único da decisão. Nunca esconde o cardápio nem o carrinho:
     só impede FINALIZAR o pedido.
     ------------------------------------------------------------------- */
  const SEM_BLOQUEIO = { bloqueia: false, motivo: null, titulo: "", mensagem: "" };

  const NAO_CONFIRMADO = {
    bloqueia: true, motivo: "desconhecido", titulo: "Horário indisponível",
    mensagem: "Não foi possível confirmar o horário de atendimento. Tente novamente."
  };

  function bloqueioHorario() {
    /* 1. sem os horários não sabemos nem se existe regra — bloqueia */
    if (!HORARIOS || HORARIOS.erro) return NAO_CONFIRMADO;

    /* 2. a casa aceita pedidos fora do horário: nada aqui impede o pedido,
          nem mesmo um relógio que não respondeu (a hora só informaria) */
    if (HORARIOS.aceitarPedidosFechado !== false) return SEM_BLOQUEIO;

    /* 3. a casa BLOQUEIA fora do horário: agora a hora precisa ser certa */
    const s = statusLoja();
    if (s.erro) return NAO_CONFIRMADO;
    if (!s.aberto) {
      const volta = s.proximaAbertura ? " Voltamos a atender " + s.proximaAbertura.texto + "." : "";
      return { bloqueia: true, motivo: "fechado", titulo: "Estamos fechados no momento.",
               mensagem: ("Estamos fechados no momento." + volta).trim(),
               complemento: (volta ? volta.trim() + " " : "") + "Você pode montar seu pedido e finalizar quando abrirmos." };
    }
    return SEM_BLOQUEIO;
  }

  /* Um tique por minuto: reavalia com o MESMO deslocamento de relógio já
     medido (nenhuma ida à rede) e só redesenha o que mudou. */
  let ultimaChaveHorario = null;
  function tiqueHorario() {
    renderStatus();
    const s = statusLoja();
    const b = bloqueioHorario();
    const chave = (s.agora ? s.agora.dia : "?") + "|" + (b.bloqueia ? b.motivo + b.mensagem : "livre");
    if (chave === ultimaChaveHorario) return;
    const primeiraVez = ultimaChaveHorario === null;
    ultimaChaveHorario = chave;
    if (!primeiraVez) {
      renderHorarios();                                   // muda o "hoje" à meia-noite
      if (abertos.indexOf("#folha-carrinho") >= 0) renderCarrinho();
    }
  }

  function avisoHorarioHTML() {
    const b = bloqueioHorario();
    if (!b.bloqueia) return "";
    return '<div class="aviso-fechado' + (b.motivo === "desconhecido" ? " incerto" : "") + '" role="status">' +
      '<span class="icone" aria-hidden="true">' + (b.motivo === "fechado" ? "🕐" : "⚠️") + "</span>" +
      "<div><strong>" + esc(b.titulo) + "</strong><p>" +
      esc(b.motivo === "fechado" ? b.complemento : b.mensagem) + "</p></div></div>";
  }

  /* ---------- 5. CARDÁPIO ------------------------------------------- */
  function produtosDaCategoria(catId) {
    if (catId === "mais-pedidas") return MENU.filter((p) => p.destaque);
    return MENU.filter((p) => p.categoria === catId);
  }

  function cardProduto(p) {
    const info = precoInicial(p);
    const legenda = temTamanhos(p) ? "<small>a partir de</small>" : "";
    const fora = indisponivel(p);
    return '<button class="produto' + (fora ? " esgotado" : "") + '" type="button" data-produto="' + esc(p.id) + '"' +
      (fora ? ' aria-disabled="true"' : "") + ">" +
      '<span class="produto-foto">' + arte(p) +
        (fora ? '<span class="selo-esgotado">Esgotado</span>'
              : (p.destaque ? '<span class="selo-destaque">Destaque</span>' : "")) +
      "</span>" +
      '<span class="produto-corpo">' +
        '<span class="produto-nome">' + esc(p.nome) + "</span>" +
        '<span class="produto-desc">' + esc(p.descricao) + "</span>" +
        '<span class="produto-rodape">' +
          '<span class="produto-preco">' + precoHTML(info, legenda) + "</span>" +
          (fora ? '<span class="produto-add desativado">Indisponível</span>'
                : '<span class="produto-add">Adicionar <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>') +
        "</span>" +
      "</span>" +
    "</button>";
  }

  function renderCardapio() {
    const alvo = $("#lista-cardapio");
    alvo.innerHTML = CATEGORIAS.map(function (c) {
      const itens = produtosDaCategoria(c.id);
      if (!itens.length) return "";
      return '<section class="secao-cardapio" id="secao-' + c.id + '" data-cat="' + c.id + '">' +
        '<div class="secao-titulo"><h2>' + c.icone + " " + esc(c.nome) + "</h2>" +
        '<span class="contagem">' + itens.length + (itens.length === 1 ? " item" : " itens") + "</span></div>" +
        '<div class="grade">' + itens.map(cardProduto).join("") + "</div>" +
      "</section>";
    }).join("");
    prepararFotos(alvo);
  }

  function renderBusca(termo) {
    const alvo = $("#lista-cardapio");
    const t = semAcento(termo);
    const achados = MENU.filter(function (p) {
      return semAcento(p.nome).indexOf(t) >= 0 || semAcento(p.descricao).indexOf(t) >= 0;
    });
    if (!achados.length) {
      alvo.innerHTML = '<div class="sem-resultado"><strong>Nada encontrado</strong>' +
        "<p>Não achamos nada para “" + esc(termo) + "”. Tente outro sabor ou veja o cardápio completo.</p></div>";
      return;
    }
    alvo.innerHTML = '<section class="secao-cardapio">' +
      '<div class="secao-titulo"><h2>Resultados</h2><span class="contagem">' + achados.length +
      (achados.length === 1 ? " item" : " itens") + "</span></div>" +
      '<div class="grade">' + achados.map(cardProduto).join("") + "</div></section>";
    prepararFotos(alvo);
  }

  /* "Mais pedidas" é uma aba do frontend: não existe como categoria no
     banco e é montada com os produtos featured. */
  function comMaisPedidas(cats, menu) {
    if (!menu.some((p) => p.destaque)) return cats;
    if (cats.some((c) => c.id === "mais-pedidas")) return cats;
    return [{ id: "mais-pedidas", nome: "Mais pedidas", icone: "🔥", destaque: true }].concat(cats);
  }

  function mostrarEsqueleto() {
    $("#rail-categorias").innerHTML = new Array(4).fill('<span class="chip-esqueleto"></span>').join("");
    const card = '<span class="produto esqueleto"><span class="bloco-esq foto"></span>' +
      '<span class="produto-corpo"><span class="bloco-esq linha g"></span>' +
      '<span class="bloco-esq linha"></span><span class="bloco-esq linha m"></span></span></span>';
    $("#lista-cardapio").innerHTML = '<section class="secao-cardapio"><div class="secao-titulo">' +
      '<span class="bloco-esq titulo"></span></div><div class="grade">' +
      new Array(6).fill(card).join("") + "</div></section>";
  }

  function mostrarErroCardapio() {
    $("#rail-categorias").innerHTML = "";
    $("#lista-cardapio").innerHTML =
      '<div class="cardapio-erro" role="alert">' +
        '<div class="icone" aria-hidden="true">🍕</div>' +
        "<strong>Não foi possível carregar o cardápio no momento.</strong>" +
        "<p>Tente novamente em alguns instantes.</p>" +
        '<button type="button" class="btn btn-principal" id="tentar-novamente">Tentar novamente</button>' +
      "</div>";
  }

  /* ---------- ESTABELECIMENTO NÃO RESOLVIDO -------------------------
     Duas situações bem diferentes, com mensagens diferentes:

       desconhecido  — o domínio não está cadastrado (ou está inativo).
                       Não existe o que carregar. A página inteira sai
                       do ar: nada de cardápio, categorias, entrega,
                       horários, carrinho, checkout ou WhatsApp. Não há
                       "tentar novamente": tentar de novo dá o mesmo.
       indisponível  — o banco não respondeu. Os dados existem, só não
                       chegaram agora; por isso o botão de repetir.

     Em nenhum dos dois casos o site carrega outra empresa.
     ------------------------------------------------------------------ */
  function mostrarTelaTenant(tipo) {
    bloqueado = true;
    MENU = []; CATEGORIAS = []; HORARIOS = null; ENTREGA_CFG = null; EMPRESA = null;

    const tela = $("#tela-tenant");
    const desconhecido = tipo === "desconhecido";
    if (tela) {
      $("#tenant-titulo").textContent = desconhecido
        ? "Estabelecimento não encontrado"
        : "Não foi possível carregar o estabelecimento";
      $("#tenant-texto").textContent = desconhecido
        ? "Este endereço não está associado a nenhum estabelecimento ativo."
        : "Tente novamente em alguns instantes.";
      $("#tenant-tentar").hidden = desconhecido;
      tela.hidden = false;
    }
    document.body.classList.add("sem-estabelecimento");
    /* nada de "Estância Treze" na aba de um domínio que não é dela */
    document.title = desconhecido ? "Estabelecimento não encontrado" : "Cardápio digital";
    fecharTudo();
  }

  function esconderTelaTenant() {
    const tela = $("#tela-tenant");
    if (tela) tela.hidden = true;
    document.body.classList.remove("sem-estabelecimento");
  }

  /* Antes de saber QUAL empresa é, nenhum nome, número ou cidade pode
     aparecer na tela. Os valores de menu-data.js são material de
     desenvolvimento e não têm nada a ver com o domínio acessado. */
  function limparMarcaAntesDeResolver() {
    CONFIG.nome = "";
    CONFIG.nomeCompleto = "";
    CONFIG.cidade = "";
    CONFIG.whatsapp = "";
    CONFIG.whatsappExibicao = "";
  }

  async function montarCardapio() {
    /* modo local: só entra quando DATA_SOURCE é trocado à mão */
    if (typeof DATA_SOURCE === "undefined" || DATA_SOURCE !== "supabase") {
      bloqueado = false;
      HORARIOS = horariosLocais();
      ENTREGA_CFG = ENTREGA_CFG || entregaLocal();
      EMPRESA = empresaLocal();
      aplicarEmpresa(EMPRESA);
      renderStatus(); renderHorarios();
      renderRail(); renderCardapio(); observarSecoes();
      revalidarCarrinhoSalvo();
      if (typeof DEBUG_CARDAPIO === "undefined" || DEBUG_CARDAPIO) {
        console.info("[cardápio] Fonte: local (menu-data.js) — nenhuma consulta ao Supabase.");
      }
      return;
    }

    esconderTelaTenant();
    mostrarEsqueleto();
    try {
      const dados = await window.Cardapio.carregar();
      if (!dados.MENU.length) throw new Error("O cardápio voltou vazio do banco.");
      if (dados.ENTREGA) ENTREGA_CFG = dados.ENTREGA;
      HORARIOS = dados.HORARIOS || window.Cardapio.horariosIndisponiveis();
      if (dados.EMPRESA) { EMPRESA = dados.EMPRESA; aplicarEmpresa(EMPRESA); }
      validarRecebimento();
      CATEGORIAS = comMaisPedidas(dados.CATEGORIAS, dados.MENU);
      MENU = dados.MENU;
      bloqueado = false;
      renderStatus(); renderHorarios();
      renderRail(); renderCardapio(); observarSecoes();
      atualizarCarrinho();
      revalidarCarrinhoSalvo();
      window.Cardapio.registrar(dados);
    } catch (e) {
      /* O domínio não resolveu: o problema é ANTES do cardápio. Nenhum
         dado de empresa nenhuma entra na página. */
      if (e && e.tenant) {
        console.error("[cardápio] " + e.message + (e.causa ? " — " + e.causa : ""));
        mostrarTelaTenant(e.tenant === window.Cardapio.ERRO_TENANT_DESCONHECIDO
          ? "desconhecido" : "indisponivel");
        return;
      }
      /* nada de cair para os preços locais sem o usuário pedir */
      bloqueado = true;
      MENU = [];
      HORARIOS = window.Cardapio.horariosIndisponiveis();
      renderStatus(); renderHorarios();
      console.error("[cardápio] Falha ao carregar do Supabase:", (e && e.message) || e);
      mostrarErroCardapio();
      atualizarCarrinho();
      fecharTudo();
    }
  }

  function renderRail() {
    $("#rail-categorias").innerHTML = CATEGORIAS.map(function (c, k) {
      return '<button class="categoria-btn" type="button" data-cat="' + c.id + '" aria-current="' + (k === 0) + '">' +
             '<span aria-hidden="true">' + c.icone + "</span>" + esc(c.nome) + "</button>";
    }).join("");
  }

  function irParaCategoria(id) {
    const sec = $("#secao-" + id);
    if (!sec) return;
    const nav = $(".navegador");
    const y = sec.getBoundingClientRect().top + window.scrollY - (nav ? nav.offsetHeight : 0) - 10;
    window.scrollTo({ top: y, behavior: "smooth" });
  }

  function observarSecoes() {
    if (!("IntersectionObserver" in window)) return;
    const nav = $(".navegador");
    const alt = (nav ? nav.offsetHeight : 100) + 16;
    if (window.__obs) window.__obs.disconnect();
    window.__obs = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (e) {
        if (!e.isIntersecting) return;
        const cat = e.target.dataset.cat;
        $$("#rail-categorias .categoria-btn").forEach(function (b) {
          const ativo = b.dataset.cat === cat;
          b.setAttribute("aria-current", String(ativo));
          if (ativo) b.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
        });
      });
    }, { rootMargin: "-" + alt + "px 0px -65% 0px", threshold: 0 });
    $$(".secao-cardapio[data-cat]").forEach((s) => window.__obs.observe(s));
  }

  /* ---------- 5.1 REVALIDAÇÃO DO CARRINHO ---------------------------
     Nunca finalizamos um pedido com preço guardado no localStorage: o
     carrinho é conferido contra o cardápio recém-carregado e de novo
     antes de abrir o WhatsApp.
     ------------------------------------------------------------------ */
  function menuNormalizado() {
    return MENU.map(function (p) {
      return {
        id: p.id, nome: p.nome,
        tipo: temTamanhos(p) ? "pizza" : "simples",
        preco: p.preco,
        disponivel: p.disponivel !== false,
        opcoes: opcoesDo(p)
      };
    });
  }

  function revalidarCarrinhoSalvo(silencioso) {
    avisosCarrinho = [];
    if (!carrinho.length || bloqueado) return { ok: true, problemas: [] };
    if (!window.Cardapio || !window.Cardapio.revalidarCarrinho) return { ok: true, problemas: [] };

    const r = window.Cardapio.revalidarCarrinho(carrinho, menuNormalizado());
    if (r.ok) return r;

    let precoMudou = false, precisaRefazer = false;
    r.problemas.forEach(function (pr) {
      if (pr.acao === "atualizar") {
        const item = carrinho.find((i) => i.uid === pr.uid);
        if (item) { item.precoBase = pr.precoBase; item.precoExtras = pr.precoExtras; }
        precoMudou = true;
      } else {
        carrinho = carrinho.filter((i) => i.uid !== pr.uid);
        precisaRefazer = true;
      }
    });

    salvarCarrinho();
    atualizarCarrinho();
    if (precoMudou) avisosCarrinho.push("Alguns preços do seu pedido foram atualizados.");
    if (precisaRefazer) avisosCarrinho.push("Um item do seu pedido precisa ser selecionado novamente.");
    if (!silencioso && avisosCarrinho.length) toast(avisosCarrinho[0]);
    console.info("[cardápio] revalidação do carrinho:", r.problemas.map((x) => x.tipo).join(", "));
    return r;
  }

  /* ---------- 6. SHEETS --------------------------------------------- */
  let abertos = [];

  function abrirFolha(id) {
    const folha = $(id), cortina = $("#cortina");
    cortina.hidden = false;
    folha.hidden = false;
    folha.scrollTop = 0;
    const corpo = $(".folha-corpo", folha);
    if (corpo) corpo.scrollTop = 0;
    requestAnimationFrame(function () {
      cortina.classList.add("aberta");
      folha.classList.add("aberta");
    });
    document.body.classList.add("trava-scroll");
    abertos.push(id);
  }

  function fecharFolha(id) {
    const alvo = id || abertos[abertos.length - 1];
    if (!alvo) return;
    const folha = $(alvo);
    folha.classList.remove("aberta");
    abertos = abertos.filter((x) => x !== alvo);
    if (!abertos.length) {
      $("#cortina").classList.remove("aberta");
      document.body.classList.remove("trava-scroll");
      setTimeout(function () { if (!abertos.length) $("#cortina").hidden = true; }, 260);
    }
    setTimeout(function () { if (!folha.classList.contains("aberta")) folha.hidden = true; }, 300);
  }

  function fecharTudo() { abertos.slice().reverse().forEach((id) => fecharFolha(id)); }

  /* confirmação simples --------------------------------------------- */
  let aoConfirmar = null;
  function confirmar(titulo, texto, rotuloOk, callback) {
    $("#confirma-titulo").textContent = titulo;
    $("#confirma-texto").textContent = texto;
    $("#confirma-ok").textContent = rotuloOk;
    aoConfirmar = callback;
    abrirFolha("#folha-confirma");
  }

  /* ---------- 7. PRODUTO -------------------------------------------- */
  let sel = null;

  function abrirProduto(id) {
    const p = produtoPorId(id);
    if (!p) return;
    if (indisponivel(p)) { toast(p.nome + " está indisponível no momento"); return; }
    if (bloqueado) { toast("Cardápio indisponível no momento"); return; }
    const op = opcoesDo(p);
    const bordaPadrao = op.bordas.length
      ? (op.bordas.find((b) => !b.preco) || op.bordas[0]).id
      : null;
    sel = { p: p, tamanho: null, borda: bordaPadrao, adicionais: [], obs: "", qtd: 1 };
    $("#produto-titulo").textContent = temTamanhos(p) ? "Monte sua pizza" : "Adicionar item";
    renderProdutoFolha();
    abrirFolha("#folha-produto");
  }

  function precoSelecionado() {
    if (!sel) return { base: 0, extras: 0, unit: 0, total: 0 };
    const p = sel.p;
    const op = opcoesDo(p);
    const tam = op.tamanhos.find((t) => t.id === sel.tamanho);
    const base = op.tamanhos.length ? (tam ? tam.preco : 0) : p.preco;
    let extras = 0;
    const b = op.bordas.find((x) => x.id === sel.borda);
    if (b) extras += b.preco;
    sel.adicionais.forEach(function (aid) {
      const a = op.adicionais.find((x) => x.id === aid);
      if (a) extras += a.preco;
    });
    return { base: base, extras: extras, unit: base + extras, total: (base + extras) * sel.qtd };
  }

  /* Uma opção é um botão acessível (role radio/checkbox) — sem <input>,
     para evitar cliques duplicados dentro de <label>. */
  function opcaoHTML(tipo, id, nome, det, preco, ativo, gratisTexto) {
    const check = tipo === "check";
    const valor = preco > 0 ? "+ " + money(preco) : (gratisTexto || "");
    return '<div class="opcao' + (ativo ? " ativa" : "") + '" data-opcao="' + tipo + '" data-id="' + esc(id) +
      '" role="' + (check ? "checkbox" : "radio") + '" aria-checked="' + (ativo ? "true" : "false") + '" tabindex="0">' +
      '<span class="marcador' + (check ? " quadrado" : "") + '"></span>' +
      '<span class="opcao-texto"><span class="opcao-nome">' + esc(nome) + "</span>" +
      (det ? '<span class="opcao-det">' + esc(det) + "</span>" : "") + "</span>" +
      '<span class="opcao-preco dinheiro' + (preco > 0 ? "" : " gratis") + '">' + valor + "</span>" +
    "</div>";
  }

  function guardarObs() {
    if (sel && $("#obs-produto")) sel.obs = $("#obs-produto").value;
  }

  function renderProdutoFolha() {
    const p = sel.p;
    const op = opcoesDo(p);
    let h = '<div class="prod-capa">' + arte(p) + "</div>" +
      '<div class="prod-topo"><h3>' + esc(p.nome) + "</h3><p>" + esc(p.descricao) + "</p></div>";

    /* tamanhos — obrigatórios quando o produto tem sizes */
    if (op.tamanhos.length) {
      h += '<div class="grupo"><div class="grupo-cabeca"><h4>Escolha o tamanho</h4>' +
           '<span class="etiqueta-obrig">Obrigatório</span></div><div class="opcoes">' +
           op.tamanhos.map(function (t) {
             return '<div class="opcao' + (sel.tamanho === t.id ? " ativa" : "") + '" data-opcao="tamanho" data-id="' + esc(t.id) +
               '" role="radio" aria-checked="' + (sel.tamanho === t.id ? "true" : "false") + '" tabindex="0">' +
               '<span class="marcador"></span>' +
               '<span class="opcao-texto"><span class="opcao-nome">' + esc(t.nome) + "</span>" +
               (t.detalhe ? '<span class="opcao-det">' + esc(t.detalhe) + "</span>" : "") + "</span>" +
               '<span class="opcao-preco">' +
                 precoHTML({ preco: t.preco, normal: t.precoNormal != null ? t.precoNormal : t.preco, promo: !!t.emPromocao }, "") +
               "</span></div>";
           }).join("") + "</div></div>";
    } else {
      const info = precoInicial(p);
      h += '<div class="grupo preco-unico"><span>Preço</span><span class="opcao-preco">' +
           precoHTML(info, "") + "</span></div>";
    }

    /* bordas — a seção some quando o produto não tem nenhuma */
    if (op.bordas.length) {
      h += '<div class="grupo"><div class="grupo-cabeca"><h4>Borda recheada</h4>' +
           '<span class="dica">Opcional</span></div><div class="opcoes">' +
           op.bordas.map(function (b) {
             return opcaoHTML("borda", b.id, b.nome, "", b.preco, sel.borda === b.id, "Grátis");
           }).join("") + "</div></div>";
    }

    /* adicionais — idem */
    if (op.adicionais.length) {
      h += '<div class="grupo"><div class="grupo-cabeca"><h4>Adicionais</h4>' +
           '<span class="dica">Escolha quantos quiser</span></div><div class="opcoes">' +
           op.adicionais.map(function (a) {
             return opcaoHTML("check", a.id, a.nome, "", a.preco, sel.adicionais.indexOf(a.id) >= 0, "");
           }).join("") + "</div></div>";
    }

    h += '<div class="grupo"><div class="grupo-cabeca"><h4>Alguma observação?</h4></div>' +
         '<textarea class="campo-obs" id="obs-produto" placeholder="Ex.: sem cebola, bem assada..." maxlength="180">' + esc(sel.obs) + "</textarea></div>";

    $("#produto-corpo").innerHTML = h;
    prepararFotos($("#produto-corpo"));
    renderRodapeProduto();
  }

  function renderRodapeProduto() {
    const pr = precoSelecionado();
    const falta = temTamanhos(sel.p) && !sel.tamanho;
    $("#produto-rodape").innerHTML =
      '<div class="contador-qtd">' +
        '<button type="button" data-qtd="-1" aria-label="Diminuir"' + (sel.qtd <= 1 ? " disabled" : "") + ">−</button>" +
        '<span class="n">' + sel.qtd + "</span>" +
        '<button type="button" data-qtd="1" aria-label="Aumentar">+</button>' +
      "</div>" +
      '<button type="button" class="btn btn-principal btn-add-produto" id="btn-adicionar"' + (falta ? " disabled" : "") + ">" +
        (falta ? "<span>Escolha o tamanho</span>"
               : '<span>Adicionar ao pedido</span><span class="dinheiro">' + money(pr.total) + "</span>") +
      "</button>";
  }

  function confirmarAdicao() {
    const p = sel.p;
    if (temTamanhos(p) && !sel.tamanho) return;
    if (indisponivel(p) || bloqueado) return;
    const op = opcoesDo(p);
    const pr = precoSelecionado();
    const t = op.tamanhos.find((x) => x.id === sel.tamanho);
    const b = op.bordas.find((x) => x.id === sel.borda);
    const obs = ($("#obs-produto") ? $("#obs-produto").value : "").trim();

    adicionarItem({
      produtoId: p.id,
      nome: p.nome,
      categoria: p.categoria,
      tamanhoId: sel.tamanho,
      tamanhoNome: t ? t.nome : "",
      bordaId: b && b.preco > 0 ? b.id : "",
      bordaNome: b && b.preco > 0 ? b.nome : "",
      adicionais: sel.adicionais.map(function (aid) {
        const a = op.adicionais.find((x) => x.id === aid);
        return { id: a.id, nome: a.nome, preco: a.preco };
      }).filter(Boolean),
      obs: obs,
      qtd: sel.qtd,
      precoBase: pr.base,
      precoExtras: pr.extras
    });

    fecharFolha("#folha-produto");
    toast("Produto adicionado ao pedido");
  }

  /* ---------- 8. CARRINHO (tela) ------------------------------------ */
  let etapa = "itens"; // "itens" | "dados"

  function abrirCarrinho() {
    etapa = "itens";
    renderCarrinho();
    abrirFolha("#folha-carrinho");
  }

  function detalhesItem(i) {
    let d = "";
    if (i.tamanhoNome) d += "<span>Tamanho: " + esc(i.tamanhoNome) + "</span>";
    if (i.bordaNome) d += "<span>Borda: " + esc(i.bordaNome) + "</span>";
    if (i.adicionais && i.adicionais.length) {
      d += "<span>Adicionais: " + i.adicionais.map((a) => esc(a.nome)).join(", ") + "</span>";
    }
    if (i.obs) d += '<span class="item-obs">Obs.: ' + esc(i.obs) + "</span>";
    return d;
  }

  /* Seção de endereço: fica sempre no DOM e abre/fecha com transição.
     Fechada, os campos não são focáveis (visibility: hidden no CSS). */
  function enderecoHTML() {
    const aberto = ehDelivery();
    const cfg = entregaCfg();

    const campos = CAMPOS_ENDERECO.map(function (c) {
      /* No modo "por bairro" o bairro deixa de ser texto livre: vem da
         lista cadastrada no painel, e o cliente não pode editá-lo. */
      if (c.chave === "bairro" && porBairro()) return campoBairroHTML();
      const valor = dados.endereco[c.chave] || "";
      return '<div class="campo-mini ' + (c.largura === "meio" ? "meio" : "cheio") + '">' +
        '<label for="' + c.id + '">' + esc(c.rotulo) + (c.obrig ? " *" : "") + "</label>" +
        '<input class="campo-texto" id="' + c.id + '" type="text" data-endereco="' + c.chave + '"' +
          (c.modo ? ' inputmode="' + c.modo + '"' : "") +
          (c.auto ? ' autocomplete="' + c.auto + '"' : "") +
          (c.chave === "cep" ? ' maxlength="9"' : ' maxlength="80"') +
          ' placeholder="' + esc(c.placeholder) + '" value="' + esc(valor) + '">' +
      "</div>";
    }).join("");

    return '<div class="secao-condicional' + (aberto ? " aberta" : "") + '" id="secao-endereco">' +
      '<div class="campo bloco-endereco">' +
        "<label>Endereço de entrega</label>" +
        '<div class="grade-endereco">' + campos + "</div>" +
        '<p class="aviso-erro" id="erro-endereco" hidden>Preencha CEP, rua, número e bairro para a entrega.</p>' +
        '<div id="nota-entrega">' + notaEntregaHTML() + "</div>" +
      "</div></div>";
  }

  function campoBairroHTML() {
    const cfg = entregaCfg();
    const escolhido = dados.zonaId || "";
    const outro = escolhido === OUTRO_BAIRRO;
    return '<div class="campo-mini cheio">' +
      '<label for="end-zona">Bairro *</label>' +
      '<select class="campo-texto" id="end-zona">' +
        '<option value=""' + (escolhido ? "" : " selected") + ">Selecione seu bairro</option>" +
        cfg.zones.map(function (z) {
          return '<option value="' + esc(z.id) + '"' + (escolhido === z.id ? " selected" : "") + ">" +
            esc(z.nome) + " — " + money(z.taxa) + "</option>";
        }).join("") +
        (cfg.allowUnlistedNeighborhoods
          ? '<option value="' + OUTRO_BAIRRO + '"' + (outro ? " selected" : "") + ">Meu bairro não está na lista</option>"
          : "") +
      "</select>" +
      '<div id="campo-bairro-livre" style="margin-top:8px"' + (outro ? "" : " hidden") + ">" +
        '<label for="end-bairro-livre">Informe seu bairro</label>' +
        '<input class="campo-texto" id="end-bairro-livre" type="text" maxlength="80" placeholder="Nome do bairro" value="' +
          esc(outro ? (dados.endereco.bairro || "") : "") + '">' +
      "</div></div>";
  }

  /* Aviso da taxa dentro da seção de endereço. */
  function notaEntregaHTML() {
    const e = entregaAtual();
    const cfg = entregaCfg();
    let h = '<p class="nota-entrega"><span aria-hidden="true">🛵</span> Taxa de entrega: <strong>' +
      esc(e.gratis ? "GRÁTIS" : e.texto) + "</strong>";
    if (e.gratis) h += "<br><small>Seu pedido atingiu o valor para entrega grátis.</small>";
    else if (e.taxaPendente) h += "<br><small>A pizzaria confirma o valor pelo WhatsApp.</small>";
    h += "</p>";
    if (cfg.minOrder > 0) {
      const t = totais().total;
      h += '<p class="nota-entrega" style="margin-top:8px">Pedido mínimo para entrega: <strong>' + money(cfg.minOrder) + "</strong>" +
        (t < cfg.minOrder
          ? '<br><small class="falta-minimo">Faltam ' + money(cfg.minOrder - t) + " para atingir o pedido mínimo.</small>"
          : "<br><small>Seu pedido já atinge o mínimo.</small>") + "</p>";
    }
    return h;
  }

  /* Resumo do checkout. No delivery, a taxa aparece separada e fora do total. */
  function resumoCheckoutHTML() {
    const t = totais();
    if (!ehDelivery()) {
      return '<div class="resumo-mini"><span>' + t.itens + (t.itens === 1 ? " item" : " itens") +
             '</span><strong class="dinheiro">' + money(t.total) + "</strong></div>";
    }
    const e = entregaAtual();
    const conhecida = !e.taxaPendente;          // sabemos o valor da entrega?
    const total = t.total + (conhecida ? e.taxa : 0);

    return '<div class="totais resumo-entrega">' +
      '<div class="linha-total"><span>Produtos</span><span class="dinheiro">' + money(t.total) + "</span></div>" +
      '<div class="linha-total"><span>Taxa de entrega</span><span class="' +
        (e.gratis ? "taxa-gratis" : (conhecida ? "dinheiro" : "a-confirmar")) + '">' +
        esc(e.gratis ? "GRÁTIS" : e.texto) + "</span></div>" +
      '<div class="linha-total destaque"><span>' + (conhecida ? "Total" : "Total dos produtos") +
        '</span><span class="dinheiro">' + money(total) + "</span></div>" +
      (conhecida ? ""
        : '<p class="nota-taxa">A taxa de entrega não está incluída neste total — ela é confirmada pela pizzaria no WhatsApp.</p>') +
      (!e.permitido && e.motivoBloqueio
        ? '<p class="nota-taxa" style="color:var(--fechado)">' + esc(e.motivoBloqueio) + "</p>" : "") +
    "</div>";
  }

  /* Marca a opção clicada sem redesenhar o formulário (preserva o que foi digitado). */
  function selecionarOpcao(el, tipo) {
    $$('.opcao[data-opcao="' + tipo + '"]', $("#carrinho-corpo")).forEach(function (o) {
      const ativo = o === el;
      o.classList.toggle("ativa", ativo);
      o.setAttribute("aria-checked", String(ativo));
    });
  }

  function atualizarResumoCheckout() {
    const alvo = $("#resumo-checkout");
    if (alvo) alvo.innerHTML = resumoCheckoutHTML();
    const nota = $("#nota-entrega");
    if (nota) nota.innerHTML = notaEntregaHTML();
  }

  function aplicarRecebimento() {
    const sec = $("#secao-endereco");
    if (sec) sec.classList.toggle("aberta", ehDelivery());
    if (!ehDelivery()) limparErrosEndereco();
    atualizarResumoCheckout();
  }

  function limparErrosEndereco() {
    CAMPOS_ENDERECO.forEach(function (c) {
      const el = $("#" + c.id);
      if (el) el.classList.remove("erro");
    });
    const aviso = $("#erro-endereco");
    if (aviso) aviso.hidden = true;
  }

  function renderCarrinho() {
    const corpo = $("#carrinho-corpo"), rodape = $("#carrinho-rodape");
    const t = totais();

    if (!carrinho.length) {
      $("#carrinho-titulo").textContent = "Seu pedido";
      corpo.innerHTML = '<div class="carrinho-vazio"><div class="icone">🍕</div>' +
        "<strong>Seu pedido está vazio</strong><p>Escolha uma pizza no cardápio para começar.</p></div>";
      rodape.innerHTML = '<button type="button" class="btn btn-principal btn-bloco" data-fechar="#folha-carrinho">Ver cardápio</button>';
      return;
    }

    if (etapa === "itens") {
      $("#carrinho-titulo").textContent = "Seu pedido";
      corpo.innerHTML = avisoHorarioHTML() + (avisosCarrinho.length
          ? '<div class="aviso-carrinho">' + avisosCarrinho.map((a) => "<p>" + esc(a) + "</p>").join("") + "</div>"
          : "") +
        carrinho.map(function (i) {
        return '<div class="item-carrinho">' +
          '<div><div class="item-nome">' + esc(i.nome) + "</div>" +
          '<div class="item-detalhes">' + detalhesItem(i) + "</div></div>" +
          '<div class="item-preco dinheiro">' + money(unitario(i) * i.qtd) + "</div>" +
          '<div class="item-acoes">' +
            '<button type="button" class="excluir" data-remover="' + i.uid + '">' +
              '<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 4h10M5.5 4V2.5h3V4M4 4l.6 8h4.8L10 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg> Excluir</button>' +
            '<div class="contador-qtd">' +
              '<button type="button" data-menos="' + i.uid + '" aria-label="Diminuir quantidade">−</button>' +
              '<span class="n">' + i.qtd + "</span>" +
              '<button type="button" data-mais="' + i.uid + '" aria-label="Aumentar quantidade">+</button>' +
            "</div>" +
          "</div></div>";
      }).join("") +
      '<div class="totais">' +
        '<div class="linha-total"><span>Subtotal</span><span class="dinheiro">' + money(t.subtotal) + "</span></div>" +
        '<div class="linha-total"><span>Bordas e adicionais</span><span class="dinheiro">' + money(t.extras) + "</span></div>" +
        '<div class="linha-total destaque"><span>Total</span><span class="dinheiro">' + money(t.total) + "</span></div>" +
      "</div>" +
      "";

      rodape.innerHTML = '<button type="button" class="btn btn-principal btn-bloco" id="ir-dados">Continuar pedido</button>';
      return;
    }

    /* ----- etapa de dados ----- */
    $("#carrinho-titulo").textContent = "Seus dados";
    corpo.innerHTML =
      '<button type="button" class="voltar" id="voltar-itens">← Voltar aos itens</button>' +
      avisoHorarioHTML() +
      '<div class="campo"><label for="cli-nome">Seu nome *</label>' +
        '<input class="campo-texto" id="cli-nome" type="text" autocomplete="name" placeholder="Como podemos te chamar?" value="' + esc(dados.nome) + '">' +
        '<p class="aviso-erro" id="erro-nome" hidden>Precisamos do seu nome para identificar o pedido.</p></div>' +

      '<div class="campo"><label>Como deseja receber?</label><div class="opcoes">' +
        modosDisponiveis().map(function (r) {
          return '<div class="opcao' + (dados.retirada === r.id ? " ativa" : "") + '" data-opcao="retirada" data-id="' + r.id +
            '" role="radio" aria-checked="' + (dados.retirada === r.id ? "true" : "false") + '" tabindex="0">' +
            '<span class="marcador"></span><span class="opcao-texto">' +
            '<span class="opcao-nome">' + r.emoji + " " + esc(r.nome) + "</span>" +
            '<span class="opcao-det">' + esc(r.detalhe) + "</span></span></div>";
        }).join("") + "</div></div>" +

      enderecoHTML() +

      '<div class="campo"><label>Forma de pagamento</label><div class="opcoes">' +
        CONFIG.pagamentos.map(function (pg) {
          return '<div class="opcao' + (dados.pagamento === pg.id ? " ativa" : "") + '" data-opcao="pagamento" data-id="' + pg.id +
            '" role="radio" aria-checked="' + (dados.pagamento === pg.id ? "true" : "false") + '" tabindex="0">' +
            '<span class="marcador"></span><span class="opcao-texto">' +
            '<span class="opcao-nome">' + pg.emoji + " " + esc(pg.nome) + "</span></span></div>";
        }).join("") + "</div>" +
        '<div id="campo-troco"' + (dados.pagamento === "dinheiro" ? "" : " hidden") + ' style="margin-top:10px">' +
          '<input class="campo-texto" id="cli-troco" type="text" inputmode="decimal" placeholder="Troco para quanto? Ex.: R$ 100,00" value="' + esc(dados.troco) + '">' +
        "</div></div>" +

      '<div class="campo"><label for="cli-obs">Observações gerais do pedido</label>' +
        '<textarea class="campo-obs" id="cli-obs" placeholder="Ex.: chegamos às 20h, pode caprichar no orégano..." maxlength="240">' + esc(dados.obs) + "</textarea></div>" +

      '<div class="campo" id="resumo-checkout">' + resumoCheckoutHTML() + "</div>";

    const bh = bloqueioHorario();
    rodape.innerHTML = '<button type="button" class="btn btn-principal btn-bloco" id="enviar-whats"' +
      (bh.bloqueia ? " disabled" : "") + ">" +
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.7 4.8-1.3A10 10 0 1 0 12 2zm0 2a8 8 0 1 1-4.1 14.9l-.3-.2-2.5.7.7-2.4-.2-.4A8 8 0 0 1 12 4zm-3.3 4c-.2 0-.5 0-.7.4l-.5 1c-.2.5-.1 1.1.2 1.7.6 1.2 1.6 2.4 2.9 3.2 1.3.8 2.2 1 2.9 1 .5 0 1-.2 1.3-.6l.5-.8c.2-.3.1-.6-.1-.7l-1.7-.9c-.3-.1-.5 0-.6.2l-.5.6c-.1.2-.3.2-.5.1-.7-.3-1.4-.8-2-1.6-.2-.2-.1-.4 0-.5l.5-.5c.2-.2.2-.4.1-.6l-.8-1.6c-.1-.3-.3-.4-.5-.4z"/></svg>' +
      " Finalizar pedido no WhatsApp</button>" +
      (bh.bloqueia ? '<p class="nota-rodape-bloqueio">' + esc(bh.mensagem) + "</p>" : "");
  }

  /* ---------- 9. FINALIZAÇÃO + WHATSAPP ------------------------------ */
  const dados = {
    nome: "",
    retirada: CONFIG.retiradas[0].id,
    pagamento: CONFIG.pagamentos[0].id,
    troco: "",
    obs: "",
    zonaId: "",          // id da zona escolhida (ou __outro__)
    endereco: { cep: "", rua: "", numero: "", bairro: "", complemento: "", referencia: "" }
  };

  /* campos de endereço: id do input, rótulo e se é obrigatório */
  const CAMPOS_ENDERECO = [
    { chave: "cep",         id: "end-cep",         rotulo: "CEP",                 obrig: true,  placeholder: "00000-000", largura: "meio", modo: "numeric", auto: "postal-code" },
    { chave: "rua",         id: "end-rua",         rotulo: "Rua / Avenida",       obrig: true,  placeholder: "Ex.: Rua das Palmeiras", largura: "cheio", auto: "address-line1" },
    { chave: "numero",      id: "end-numero",      rotulo: "Número",              obrig: true,  placeholder: "123", largura: "meio" },
    { chave: "complemento", id: "end-complemento", rotulo: "Complemento",         obrig: false, placeholder: "Apto, bloco (opcional)", largura: "meio" },
    { chave: "bairro",      id: "end-bairro",      rotulo: "Bairro",              obrig: true,  placeholder: "Ex.: Centro", largura: "cheio", auto: "address-level3" },
    { chave: "referencia",  id: "end-referencia",  rotulo: "Ponto de referência", obrig: false, placeholder: "Ex.: ao lado da padaria (opcional)", largura: "cheio" }
  ];

  const modoRecebimento = () =>
    CONFIG.retiradas.find((r) => r.id === dados.retirada) || CONFIG.retiradas[0];
  const ehDelivery = () => !!modoRecebimento().pedeEndereco;

  /* Modos exibidos: o delivery some quando está desligado no painel ou
     quando as configurações não puderam ser carregadas. */
  function modosDisponiveis() {
    return CONFIG.retiradas.filter((r) => !r.pedeEndereco || entregaDisponivel());
  }

  /* Se o delivery deixou de existir, a seleção do cliente é invalidada. */
  function validarRecebimento() {
    if (ehDelivery() && !entregaDisponivel()) {
      dados.retirada = CONFIG.retiradas[0].id;
      dados.zonaId = "";
      return false;
    }
    return true;
  }

  /* -------------------------------------------------------------------
     REGRAS DE ENTREGA
     ENTREGA_CFG é a ÚNICA estrutura consultada pelo checkout. Vem do
     Supabase (delivery_settings + delivery_zones) quando DATA_SOURCE é
     "supabase", ou do CONFIG.entrega local no modo de desenvolvimento.
     ------------------------------------------------------------------- */
  let ENTREGA_CFG = null;

  function entregaLocal() {
    const c = CONFIG.entrega || {};
    return {
      erro: false,
      enabled: c.ativa !== false,
      feeMode: typeof c.taxa === "number" ? "fixed" : "confirm",
      fixedFee: typeof c.taxa === "number" ? c.taxa : null,
      minOrder: Number(c.pedidoMinimo) || 0,
      freeDeliveryAbove: typeof c.gratisAcimaDe === "number" ? c.gratisAcimaDe : null,
      allowUnlistedNeighborhoods: true,
      zones: []
    };
  }

  const entregaCfg = () => ENTREGA_CFG || (ENTREGA_CFG = entregaLocal());
  const entregaDisponivel = () => { const c = entregaCfg(); return !c.erro && c.enabled; };
  const porBairro = () => entregaCfg().feeMode === "by_neighborhood";
  const zonaPorId = (id) => entregaCfg().zones.find((z) => z.id === id);

  /* -------------------------------------------------------------------
     Cálculo único da entrega. Resumo, validação e mensagem do WhatsApp
     leem SEMPRE daqui — nenhuma dessas regras é recalculada em outro lugar.

     Ordem: disponibilidade → pedido mínimo → taxa do modo → entrega grátis.
     ------------------------------------------------------------------- */
  function calcularEntrega(subtotal, zonaId) {
    const c = entregaCfg();
    const r = {
      permitido: true, motivoBloqueio: null,
      taxa: 0, taxaPendente: false, gratis: false,
      bairro: null, zonaId: zonaId || null,
      minimo: c.minOrder || 0, falta: 0,
      texto: "A confirmar"
    };

    if (c.erro) {
      r.permitido = false; r.taxaPendente = true;
      r.motivoBloqueio = "Delivery indisponível no momento.";
      return r;
    }
    if (!c.enabled) {
      r.permitido = false; r.taxaPendente = true;
      r.motivoBloqueio = "A entrega está indisponível no momento.";
      return r;
    }

    /* 1. pedido mínimo — só sobre os produtos, antes da taxa */
    if (c.minOrder > 0 && subtotal < c.minOrder) {
      r.permitido = false;
      r.falta = c.minOrder - subtotal;
      r.motivoBloqueio = "Faltam " + money(r.falta) + " para atingir o pedido mínimo.";
    }

    /* 2. taxa conforme o modo */
    if (c.feeMode === "fixed") {
      r.taxa = typeof c.fixedFee === "number" ? c.fixedFee : 0;
      r.texto = money(r.taxa);
    } else if (c.feeMode === "by_neighborhood") {
      if (zonaId === OUTRO_BAIRRO) {
        if (!c.allowUnlistedNeighborhoods) {
          r.permitido = false;
          r.motivoBloqueio = r.motivoBloqueio || "Escolha um dos bairros atendidos.";
        }
        r.taxaPendente = true; r.taxa = 0; r.texto = "A confirmar";
      } else {
        const z = zonaPorId(zonaId);
        if (!z) {
          r.permitido = false;
          r.motivoBloqueio = r.motivoBloqueio || "Selecione o seu bairro para calcular a entrega.";
          r.taxaPendente = true; r.texto = "A confirmar";
        } else {
          r.bairro = z.nome; r.taxa = z.taxa; r.texto = money(z.taxa);
        }
      }
    } else {
      r.taxaPendente = true; r.taxa = 0; r.texto = "A confirmar";
    }

    /* 3. entrega grátis tem prioridade sobre taxa fixa e taxa por bairro */
    if (typeof c.freeDeliveryAbove === "number" && subtotal >= c.freeDeliveryAbove) {
      r.gratis = true; r.taxa = 0; r.taxaPendente = false; r.texto = "GRÁTIS";
    }
    return r;
  }

  const OUTRO_BAIRRO = "__outro__";

  /* A entrega do pedido atual, já com o bairro escolhido. */
  const entregaAtual = () => calcularEntrega(totais().total, dados.zonaId);

  function lerFormulario() {
    if ($("#cli-nome")) dados.nome = $("#cli-nome").value.trim();
    if ($("#cli-troco")) dados.troco = $("#cli-troco").value.trim();
    if ($("#cli-obs")) dados.obs = $("#cli-obs").value.trim();
    CAMPOS_ENDERECO.forEach(function (c) {
      const el = $("#" + c.id);
      if (el) dados.endereco[c.chave] = el.value.trim();
    });
    const sel = $("#end-zona");
    if (sel) {
      dados.zonaId = sel.value;
      const z = zonaPorId(sel.value);
      if (z) dados.endereco.bairro = z.nome;              // bairro vem da zona
      else if (sel.value === OUTRO_BAIRRO && $("#end-bairro-livre")) {
        dados.endereco.bairro = $("#end-bairro-livre").value.trim();
      }
    }
  }

  /* Endereço em uma ou mais linhas, para a mensagem do WhatsApp. */
  function enderecoLinhas() {
    const e = dados.endereco;
    const linhas = [];
    linhas.push(e.rua + (e.numero ? ", " + e.numero : ""));
    if (e.bairro) linhas.push(e.bairro);
    if (e.cep) linhas.push("CEP " + e.cep);
    return linhas;
  }

  function linhaItem(i) {
    const cat = i.categoria === "bebidas" ? "🥤 " : "";
    let l = cat + i.qtd + "x " + i.nome + (i.tamanhoNome ? " — " + i.tamanhoNome : "");
    if (i.bordaNome) l += "\nBorda: " + i.bordaNome;
    if (i.adicionais && i.adicionais.length) {
      l += "\n" + i.adicionais.map((a) => "• " + a.nome).join("\n");
    }
    if (i.obs) l += "\nObs.: " + i.obs;
    l += "\n" + money(unitario(i) * i.qtd);
    return l;
  }

  function montarMensagem() {
    const t = totais();
    const divisor = "━━━━━━━━━━━━━━";
    const retirada = CONFIG.retiradas.find((r) => r.id === dados.retirada) || CONFIG.retiradas[0];
    const pagamento = CONFIG.pagamentos.find((p) => p.id === dados.pagamento) || CONFIG.pagamentos[0];

    const linhas = [];
    linhas.push("🍕 *NOVO PEDIDO — " + nomeEmpresa().toUpperCase() + "*");
    linhas.push("👤 Cliente: " + (dados.nome || "Não informado"));
    linhas.push(divisor);
    carrinho.forEach(function (i) {
      linhas.push(linhaItem(i));
      linhas.push(divisor);
    });
    const delivery = !!retirada.pedeEndereco;

    if (!delivery) linhas.push("💰 *TOTAL: " + money(t.total) + "*");
    linhas.push(retirada.emoji + " " + retirada.nome);

    /* Bloco de entrega — só existe quando o pedido é delivery. */
    if (delivery) {
      const end = dados.endereco;
      const e = entregaAtual();
      const taxaTexto = e.gratis ? "GRÁTIS" : (e.taxaPendente ? "a confirmar" : money(e.taxa));

      linhas.push(divisor);
      linhas.push("🚚 *ENTREGA*");
      linhas.push("");
      linhas.push("📍 " + end.rua + (end.numero ? ", " + end.numero : ""));
      if (end.bairro) linhas.push("Bairro: " + end.bairro);
      if (end.cep) linhas.push("CEP: " + end.cep);
      if (end.complemento) linhas.push("Complemento: " + end.complemento);
      if (end.referencia) linhas.push("Referência: " + end.referencia);
      linhas.push("");
      linhas.push("🛵 Taxa de entrega: " + taxaTexto);
      linhas.push(divisor);
      linhas.push("💰 Produtos: " + money(t.total));
      linhas.push("🚚 Entrega: " + taxaTexto);
      if (e.taxaPendente) linhas.push("💰 *Total dos produtos: " + money(t.total) + "*");
      else linhas.push("💰 *TOTAL: " + money(t.total + e.taxa) + "*");
      linhas.push(divisor);
    }

    linhas.push(pagamento.emoji + " Pagamento: " + pagamento.nome +
      (dados.pagamento === "dinheiro" && dados.troco ? " (troco para " + dados.troco + ")" : ""));
    if (dados.obs) linhas.push("📝 Obs.: " + dados.obs);
    linhas.push(divisor);
    linhas.push("Pedido realizado pelo cardápio digital.");
    if (CONFIG.demo) linhas.push("⚠️ " + CONFIG.avisoDemo);
    return linhas.join("\n");
  }

  /* Validação amigável: marca os campos, explica o que falta e não abre
     o WhatsApp. Devolve true quando está tudo certo. */
  function checkoutValido() {
    /* 1. horário: sem confirmação de que estamos atendendo, nada segue */
    const bh = bloqueioHorario();
    if (bh.bloqueia) {
      renderCarrinho();
      const corpo = $(".folha-corpo", $("#folha-carrinho"));
      if (corpo) corpo.scrollTop = 0;
      toast(bh.mensagem, "erro");
      return false;
    }

    /* 2. dados do cliente */
    if (!dados.nome) {
      const campo = $("#cli-nome");
      if (campo) {
        campo.classList.add("erro");
        $("#erro-nome").hidden = false;
        campo.focus();
        campo.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      toast("Falta o seu nome");
      return false;
    }

    /* 3. modo de recebimento e regras de entrega (mínimo, taxa, bairro) */
    if (ehDelivery()) {
      const e = entregaAtual();
      if (!e.permitido) {
        const aviso = $("#erro-endereco");
        if (aviso) { aviso.textContent = e.motivoBloqueio; aviso.hidden = false; }
        toast(e.motivoBloqueio, "erro");
        const sel = $("#end-zona");
        if (sel && !dados.zonaId) { sel.focus(); sel.scrollIntoView({ block: "center", behavior: "smooth" }); }
        return false;
      }

      const faltando = CAMPOS_ENDERECO.filter(function (c) {
        return c.obrig && !dados.endereco[c.chave];
      });
      if (faltando.length) {
        faltando.forEach(function (c) {
          const el = $("#" + c.id);
          if (el) el.classList.add("erro");
        });
        const aviso = $("#erro-endereco");
        if (aviso) {
          aviso.textContent = faltando.length === 1
            ? "Falta preencher: " + faltando[0].rotulo + "."
            : "Falta preencher: " + faltando.map((c) => c.rotulo.toLowerCase()).join(", ") + ".";
          aviso.hidden = false;
        }
        const primeiro = $("#" + faltando[0].id);
        if (primeiro) {
          primeiro.focus();
          primeiro.scrollIntoView({ block: "center", behavior: "smooth" });
        }
        toast("Complete o endereço de entrega");
        return false;
      }
    }
    return true;
  }

  async function enviarWhatsApp() {
    lerFormulario();
    if (bloqueado) {
      toast("Cardápio indisponível — tente novamente em instantes");
      return;
    }

    /* HORÁRIO — antes de qualquer outra conferência, a hora é buscada de
       novo no servidor e as tabelas de horário são relidas: a loja pode
       ter fechado (ou o painel pode ter mudado a regra) enquanto o
       cliente montava o pedido. */
    if (typeof DATA_SOURCE !== "undefined" && DATA_SOURCE === "supabase" &&
        window.Cardapio && window.Cardapio.recarregarHorarios) {
      const estavaAberto = statusLoja().aberto;
      try {
        HORARIOS = await window.Cardapio.recarregarHorarios();
      } catch (e) {
        HORARIOS = window.Cardapio.horariosIndisponiveis();
      }
      renderStatus(); renderHorarios();

      const bh = bloqueioHorario();
      if (bh.bloqueia) {
        renderCarrinho();
        const corpo = $(".folha-corpo", $("#folha-carrinho"));
        if (corpo) corpo.scrollTop = 0;
        toast(
          (bh.motivo === "fechado" && estavaAberto)
            ? "O horário de atendimento mudou enquanto você fazia o pedido. Estamos fechados no momento."
            : bh.mensagem,
          "erro"
        );
        return;
      }
    }

    /* Antes de abrir o WhatsApp, as regras de entrega são relidas do banco:
       delivery pode ter sido desligado, o bairro removido ou a taxa alterada
       enquanto o cliente montava o pedido. Nada aqui vem do localStorage. */
    if (ehDelivery() && DATA_SOURCE === "supabase" && window.Cardapio && window.Cardapio.recarregarEntrega) {
      const antes = entregaAtual();
      try {
        ENTREGA_CFG = await window.Cardapio.recarregarEntrega();
      } catch (e) { /* mantém o que já estava carregado */ }

      if (!validarRecebimento()) {
        renderCarrinho();
        toast("A entrega foi desativada. Escolha outra forma de recebimento.", "erro");
        return;
      }
      const depois = entregaAtual();
      const mudou = depois.taxa !== antes.taxa || depois.taxaPendente !== antes.taxaPendente ||
                    depois.gratis !== antes.gratis;
      if (!depois.permitido) {
        atualizarResumoCheckout();
        const aviso = $("#erro-endereco");
        if (aviso) { aviso.textContent = depois.motivoBloqueio; aviso.hidden = false; }
        toast(depois.motivoBloqueio, "erro");
        return;
      }
      if (mudou) {
        atualizarResumoCheckout();
        toast("A taxa de entrega foi atualizada. Confira antes de enviar.", "erro");
        return;
      }
    }
    /* Última conferência: o pedido nunca sai com preço antigo do localStorage. */
    const conferencia = revalidarCarrinhoSalvo(true);
    if (!conferencia.ok) {
      etapa = "itens";
      renderCarrinho();
      toast(avisosCarrinho[0] || "Confira seu pedido");
      return;
    }
    if (!checkoutValido()) return;
    if (!carrinho.length) return;

    /* EMPRESA — última leitura antes de montar a URL. O dono pode ter
       trocado o número no painel com esta página aberta há horas.
       Se a releitura falhar, seguimos com o que veio do banco no
       carregamento (nunca com número escrito no código); se não houver
       número válido nenhum, o pedido não sai e o carrinho fica intacto. */
    if (typeof DATA_SOURCE !== "undefined" && DATA_SOURCE === "supabase" &&
        window.Cardapio && window.Cardapio.recarregarEmpresa) {
      try {
        const atual = await window.Cardapio.recarregarEmpresa();
        if (atual) { EMPRESA = atual; aplicarEmpresa(atual); }
      } catch (e) {
        console.warn("[cardápio] não foi possível reconferir a empresa:", (e && e.message) || e);
      }
    }

    const numero = numeroWhats();
    if (!numero) {
      console.error("[cardápio] WhatsApp da empresa indisponível:",
        (EMPRESA && EMPRESA.whatsappMotivo) || "empresa não carregada");
      toast(SEM_WHATS, "erro");
      return;                                   // carrinho e checkout preservados
    }

    const url = "https://wa.me/" + numero + "?text=" + encodeURIComponent(montarMensagem());
    window.open(url, "_blank", "noopener");
    setTimeout(function () {
      confirmar(
        "Pedido enviado ao WhatsApp",
        "Se você já enviou a mensagem para a pizzaria, podemos limpar o carrinho. Quer manter os itens para conferir?",
        "Limpar carrinho",
        function () { limparCarrinho(); fecharTudo(); toast("Carrinho limpo"); }
      );
    }, 700);
  }

  /* ---------- TOAST -------------------------------------------------- */
  let toastTimer = null;
  function toast(texto) {
    const el = $("#toast");
    el.innerHTML = '<span aria-hidden="true">✓</span><span>' + esc(texto) + "</span>";
    el.classList.add("visivel");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("visivel"); }, 2200);
  }

  /* ---------- 10. INICIALIZAÇÃO -------------------------------------- */
  function renderHero() {
    const alvo = $("#hero-foto");
    if (!alvo) return;
    const uid = "hero";
    let h = '<svg viewBox="0 0 200 200" aria-hidden="true" preserveAspectRatio="xMidYMid slice">' +
      pizzaSVG({ massa: "#E9BB6A", base: "#D2431F", itens: [
        { forma: "circulo", cor: "#8E2B1F", borda: "#6C1D14", n: 10, tam: 15 },
        { forma: "gota",    cor: "#FAEFCF", n: 8,  tam: 16 },
        { forma: "folha",   cor: "#3F7A38", n: 7,  tam: 12 }
      ] }, 1313, uid) + "</svg>";
    if (CONFIG.heroImagem) {
      h += '<img class="foto-real" src="' + esc(CONFIG.heroImagem) +
           '" alt="Pizza recém-saída do forno" decoding="async">';
    }
    alvo.innerHTML = h;
    prepararFotos(alvo);
  }

  function preencherTextos() {
    $$("[data-config]").forEach(function (el) {
      const chave = el.dataset.config;
      const valor = chave.split(".").reduce((o, k) => (o ? o[k] : ""), CONFIG);
      if (valor != null) el.textContent = valor;
      /* item do topo sem conteúdo some inteiro, para não sobrar só o ícone */
      const item = el.closest(".info-item");
      if (item && item.children.length === 1) item.hidden = !String(valor || "").trim();
    });
    /* Sem número válido da empresa não existe link de WhatsApp: nada de
       apontar para um número antigo escrito no código. */
    const numero = numeroWhats();
    $$("[data-whats]").forEach(function (el) {
      if (!numero) { el.removeAttribute("href"); el.hidden = true; return; }
      el.hidden = false;
      el.href = "https://wa.me/" + numero + "?text=" +
        encodeURIComponent("Olá! Vim pelo cardápio digital da " + nomeEmpresa() + ".");
    });
    $("#nota-valor").textContent = CONFIG.avaliacao.toLocaleString("pt-BR", { minimumFractionDigits: 1 });
    $$(".conta-avaliacoes").forEach(function (el) {
      el.textContent = CONFIG.totalAvaliacoes.toLocaleString("pt-BR") + " avaliações";
    });
    $("#nota-topo").textContent = CONFIG.avaliacao.toLocaleString("pt-BR", { minimumFractionDigits: 1 });
    $("#ano").textContent = new Date().getFullYear();
    if (!CONFIG.demo) $$(".so-demo").forEach((el) => (el.hidden = true));
    renderServicos();
  }

  /* Card "Serviços": os fixos de CONFIG mais o Delivery, que entra apenas
     quando as regras JÁ carregadas dizem que ele está ativo.
     Fonte única: o mesmo ENTREGA_CFG que o checkout usa — nenhuma consulta
     a mais. Estado desconhecido (não carregou, ou falhou) não anuncia
     Delivery, igual ao que o checkout faz. */
  function renderServicos() {
    const el = $("#servicos");
    if (!el) return;
    const itens = (CONFIG.servicos || []).slice();
    if (ENTREGA_CFG && !ENTREGA_CFG.erro && ENTREGA_CFG.enabled === true) itens.push("Delivery");
    el.innerHTML = itens.map(function (s) {
      return '<li><span class="tique">✓</span>' + esc(s) + "</li>";
    }).join("");
  }

  function ligarEventos() {
    /* abrir produto */
    document.addEventListener("click", function (ev) {
      const card = ev.target.closest("[data-produto]");
      if (card) { abrirProduto(card.dataset.produto); return; }

      const fechar = ev.target.closest("[data-fechar]");
      if (fechar) { fecharFolha(fechar.dataset.fechar); return; }

      /* opções dentro da folha de produto / dados */
      const op = ev.target.closest(".opcao");
      if (op) {
        const tipo = op.dataset.opcao, id = op.dataset.id;
        if (tipo === "tamanho") { guardarObs(); sel.tamanho = id; renderProdutoFolha(); }
        else if (tipo === "borda") { guardarObs(); sel.borda = id; renderProdutoFolha(); }
        else if (tipo === "check") {
          guardarObs();
          const k = sel.adicionais.indexOf(id);
          if (k >= 0) sel.adicionais.splice(k, 1); else sel.adicionais.push(id);
          renderProdutoFolha();
        } else if (tipo === "retirada") {
          lerFormulario();
          dados.retirada = id;
          selecionarOpcao(op, "retirada");
          aplicarRecebimento();
        } else if (tipo === "pagamento") {
          lerFormulario();
          dados.pagamento = id;
          selecionarOpcao(op, "pagamento");
          const troco = $("#campo-troco");
          if (troco) troco.hidden = id !== "dinheiro";
        }
        return;
      }

      const qtd = ev.target.closest("[data-qtd]");
      if (qtd) {
        const d = Number(qtd.dataset.qtd);
        sel.qtd = Math.max(1, Math.min(30, sel.qtd + d));
        guardarObs();
        renderRodapeProduto();
        return;
      }

      if (ev.target.closest("#btn-adicionar")) { confirmarAdicao(); return; }
      if (ev.target.closest("#abrir-carrinho") || ev.target.closest("#barra-carrinho button")) { abrirCarrinho(); return; }
      if (ev.target.closest("#ir-dados")) { etapa = "dados"; renderCarrinho(); $(".folha-corpo", $("#folha-carrinho")).scrollTop = 0; return; }
      if (ev.target.closest("#voltar-itens")) { lerFormulario(); etapa = "itens"; renderCarrinho(); return; }
      if (ev.target.closest("#enviar-whats")) { enviarWhatsApp(); return; }

      const mais = ev.target.closest("[data-mais]");
      if (mais) { lerFormulario(); mudarQtd(mais.dataset.mais, 1); return; }
      const menos = ev.target.closest("[data-menos]");
      if (menos) { lerFormulario(); mudarQtd(menos.dataset.menos, -1); return; }
      const rem = ev.target.closest("[data-remover]");
      if (rem) { lerFormulario(); removerItem(rem.dataset.remover); return; }

      const cat = ev.target.closest("[data-cat]");
      if (cat && cat.classList.contains("categoria-btn")) {
        if ($("#campo-busca").value) { $("#campo-busca").value = ""; aplicarBusca(); }
        $$("#rail-categorias .categoria-btn").forEach((b) => b.setAttribute("aria-current", String(b === cat)));
        irParaCategoria(cat.dataset.cat);
        return;
      }

      if (ev.target.closest("#tentar-novamente")) { montarCardapio(); return; }
      if (ev.target.closest("#tenant-tentar")) { montarCardapio(); return; }

      if (ev.target.closest("#confirma-ok")) {
        const cb = aoConfirmar; aoConfirmar = null;
        fecharFolha("#folha-confirma");
        if (cb) cb();
        return;
      }
    });

    /* cortina, ESC e teclado nas opções */
    $("#cortina").addEventListener("click", function () { fecharFolha(); });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && abertos.length) { ev.preventDefault(); fecharFolha(); return; }
      if ((ev.key === "Enter" || ev.key === " ") && ev.target.classList && ev.target.classList.contains("opcao")) {
        ev.preventDefault();
        ev.target.click();
      }
    });

    /* bairro escolhido na lista */
    document.addEventListener("change", function (ev) {
      if (ev.target.id !== "end-zona") return;
      lerFormulario();
      dados.zonaId = ev.target.value;
      const livre = $("#campo-bairro-livre");
      if (livre) livre.hidden = ev.target.value !== OUTRO_BAIRRO;
      if (ev.target.value !== OUTRO_BAIRRO) {
        const z = zonaPorId(ev.target.value);
        dados.endereco.bairro = z ? z.nome : "";
      } else {
        dados.endereco.bairro = $("#end-bairro-livre") ? $("#end-bairro-livre").value.trim() : "";
      }
      const aviso = $("#erro-endereco");
      if (aviso) aviso.hidden = true;
      atualizarResumoCheckout();
    });

    /* limpa estado de erro e aplica a máscara do CEP */
    document.addEventListener("input", function (ev) {
      const alvo = ev.target;
      if (alvo.id === "cli-nome") {
        alvo.classList.remove("erro");
        const erro = $("#erro-nome"); if (erro) erro.hidden = true;
        return;
      }
      if (alvo.id === "end-bairro-livre") {
        dados.endereco.bairro = alvo.value.trim();
        const aviso = $("#erro-endereco");
        if (aviso) aviso.hidden = true;
        return;
      }
      if (alvo.dataset && alvo.dataset.endereco) {
        if (alvo.dataset.endereco === "cep") {
          const so = alvo.value.replace(/\D/g, "").slice(0, 8);
          alvo.value = so.length > 5 ? so.slice(0, 5) + "-" + so.slice(5) : so;
        }
        alvo.classList.remove("erro");
        const aviso = $("#erro-endereco");
        if (aviso && !$$(".campo-texto.erro", $("#secao-endereco")).length) aviso.hidden = true;
      }
    });

    /* busca */
    let tBusca = null;
    $("#campo-busca").addEventListener("input", function () {
      clearTimeout(tBusca);
      tBusca = setTimeout(aplicarBusca, 160);
    });
    $("#limpar-busca").addEventListener("click", function () {
      $("#campo-busca").value = "";
      aplicarBusca();
      $("#campo-busca").focus();
    });

    /* sombra na barra sticky */
    const nav = $(".navegador");
    window.addEventListener("scroll", function () {
      nav.classList.toggle("grudado", nav.getBoundingClientRect().top <= 0 && window.scrollY > 10);
    }, { passive: true });

    /* ver cardápio */
    $("#ver-cardapio").addEventListener("click", function () { irParaCategoria(CATEGORIAS[0].id); });
  }

  function aplicarBusca() {
    if (bloqueado) return;
    const termo = $("#campo-busca").value.trim();
    $("#limpar-busca").hidden = !termo;
    $("#rail-categorias").parentElement.classList.toggle("buscando", !!termo);
    if (termo) { renderBusca(termo); }
    else { renderCardapio(); observarSecoes(); }
  }

  async function iniciar() {
    /* Ligado ao banco, a identidade da casa só existe depois que o
       domínio resolver. Até lá a página fica sem nome, sem número e sem
       cidade — é o que impede o "flash" da marca errada. */
    if (typeof DATA_SOURCE !== "undefined" && DATA_SOURCE === "supabase") {
      limparMarcaAntesDeResolver();
    }
    preencherTextos();
    renderHero();
    renderStatus();
    renderHorarios();
    carregarCarrinho();
    atualizarCarrinho();
    ligarEventos();
    setInterval(tiqueHorario, 60000);
    await montarCardapio();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();
