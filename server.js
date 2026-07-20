const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 }, // 8MB por imagem, até 6 anexos
});

const PORT = process.env.PORT || 3000;

const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
// Aceita o link curto do board (o que aparece na URL, ex: "XIQU86kd") ou o id longo.
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID;
// Nome exato da lista onde os chamados novos devem cair.const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 }, // 8MB por imagem, até 6 anexos
});

const PORT = process.env.PORT || 3000;

const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
// Aceita o link curto do board (o que aparece na URL, ex: "XIQU86kd") ou o id longo.
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID;
// Nome exato da lista onde os chamados novos devem cair.
const LISTA_DESTINO = process.env.TRELLO_LISTA_DESTINO || "TAREFAS PENDENTES";
// Nome exato da lista pra onde um chamado vai quando você marca como resolvido.
const LISTA_FINALIZADA = process.env.TRELLO_LISTA_FINALIZADA || "FINALIZADAS";
// Nome exato da lista pra onde o chamado vai enquanto espera a confirmação
// de quem abriu (antes de virar "finalizado" de vez).
const LISTA_APROVACAO = process.env.TRELLO_LISTA_APROVACAO || "AGUARDANDO APROVAÇÃO";
// Senha do seu painel privado (/painel). Sem isso configurado, o painel fica bloqueado.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!TRELLO_API_KEY || !TRELLO_TOKEN || !TRELLO_BOARD_ID) {
  console.error("⚠️  Faltam variáveis de ambiente: TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID");
}

const auth = () => `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;

// Cache simples em memória do id da lista e das etiquetas do board.
// Evita bater na API do Trello a cada chamado aberto.
let cache = { idList: null, idListFinalizada: null, idListAprovacao: null, labels: null, carregadoEm: 0 };
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

async function carregarCache() {
  const [listsRes, labelsRes] = await Promise.all([
    fetch(`https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/lists?${auth()}`),
    fetch(`https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/labels?${auth()}&limit=1000`),
  ]);

  if (!listsRes.ok) throw new Error(`Falha ao buscar listas do Trello: ${listsRes.status}`);
  if (!labelsRes.ok) throw new Error(`Falha ao buscar etiquetas do Trello: ${labelsRes.status}`);

  const lists = await listsRes.json();
  const labels = await labelsRes.json();

  const norm = (s) => s.trim().toLowerCase();

  const lista = lists.find((l) => norm(l.name) === norm(LISTA_DESTINO));
  if (!lista) {
    throw new Error(
      `Lista "${LISTA_DESTINO}" não encontrada no board. Listas disponíveis: ${lists.map((l) => l.name).join(", ")}`
    );
  }

  const listaFinalizada = lists.find((l) => norm(l.name) === norm(LISTA_FINALIZADA));
  if (!listaFinalizada) {
    console.warn(
      `⚠️  Lista "${LISTA_FINALIZADA}" não encontrada — o botão de resolver no /painel vai falhar até isso existir.`
    );
  }

  const listaAprovacao = lists.find((l) => norm(l.name) === norm(LISTA_APROVACAO));
  if (!listaAprovacao) {
    console.warn(
      `⚠️  Lista "${LISTA_APROVACAO}" não encontrada — a etapa de confirmação com quem abriu o chamado vai falhar até isso existir.`
    );
  }

  cache = {
    idList: lista.id,
    idListFinalizada: listaFinalizada ? listaFinalizada.id : null,
    idListAprovacao: listaAprovacao ? listaAprovacao.id : null,
    // Mantém id + nome + cor pra devolver ao front sem chamar o Trello de novo.
    labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    carregadoEm: Date.now(),
  };

  console.log(`✅ Cache carregado — lista "${lista.name}" (${lista.id}), ${labels.length} etiquetas`);
}

async function garantirCache() {
  if (!cache.idList || Date.now() - cache.carregadoEm > CACHE_TTL_MS) {
    await carregarCache();
  }
}

// Extrai "Solicitante: Nome (telefone)" da descrição do cartão — é assim que
// guardamos quem abriu o chamado, já que o formulário público não tem login.
function extrairSolicitante(desc) {
  const m = /^Solicitante: (.+?) \((.*?)\)\s*$/m.exec(desc || "");
  return m ? { nome: m[1].trim(), telefone: m[2].trim() } : null;
}

// Token curto pra proteger os links de confirmação que vão por WhatsApp —
// sem precisar guardar nada em banco, só recalcula e compara.
function gerarToken(cardId) {
  return crypto
    .createHmac("sha256", ADMIN_PASSWORD || "segredo-padrao-troque-a-senha")
    .update(cardId)
    .digest("hex")
    .slice(0, 20);
}
function tokenValido(cardId, token) {
  return typeof token === "string" && token === gerarToken(cardId);
}

// Etiquetas para o formulário — devolve o que o front precisa pra desenhar
// as opções coloridas.
// Protege as rotas do painel. Sem ADMIN_PASSWORD configurada, ninguém entra.
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: "Painel não configurado (falta ADMIN_PASSWORD no servidor)." });
  }
  const senha = req.headers["x-admin-password"];
  if (senha !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Senha incorreta." });
  }
  next();
}

// Lista os chamados em aberto (qualquer lista do board, menos a de finalizados).
app.get("/api/chamados", requireAdmin, async (req, res) => {
  try {
    await garantirCache();

    const camposCartao = "name,desc,due,idList,shortUrl,idLabels,dateLastActivity";
    const cardsRes = await fetch(
      `https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/cards/open?${auth()}&fields=${camposCartao}&attachments=true&attachment_fields=id,name,mimeType,url`
    );
    if (!cardsRes.ok) throw new Error(`Falha ao buscar cartões: ${cardsRes.status}`);
    const cards = await cardsRes.json();

    const abertos = cards
      .filter((c) => c.idList !== cache.idListFinalizada && c.idList !== cache.idListAprovacao)
      .map((c) => ({
        id: c.id,
        titulo: c.name,
        descricao: c.desc,
        dataDesejada: c.due,
        url: c.shortUrl,
        ultimaAtividade: c.dateLastActivity,
        etiquetas: (c.idLabels || [])
          .map((id) => cache.labels.find((l) => l.id === id))
          .filter(Boolean),
        imagens: (c.attachments || [])
          .filter((a) => a.mimeType && a.mimeType.startsWith("image/"))
          .map((a) => ({ id: a.id, nome: a.name, url: a.url })),
      }))
      // Mais recentes primeiro.
      .sort((a, b) => new Date(b.ultimaAtividade) - new Date(a.ultimaAtividade));

    res.json({ chamados: abertos });
  } catch (err) {
    console.error("Erro ao listar chamados:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Marca um chamado como resolvido: move o cartão pra lista de finalizados.
// Não apaga de verdade — o cartão continua existindo, só sai da fila ativa.
app.post("/api/chamados/:id/resolver", requireAdmin, express.json(), async (req, res) => {
  try {
    await garantirCache();

    if (!cache.idListAprovacao) {
      return res.status(500).json({
        error: `Lista "${LISTA_APROVACAO}" não encontrada no board — configure TRELLO_LISTA_APROVACAO ou crie a lista.`,
      });
    }

    const cardId = req.params.id;
    const descricao = (req.body && req.body.descricao) || "";
    const titulo = (req.body && req.body.titulo) || "";

    const moveRes = await fetch(
      `https://api.trello.com/1/cards/${cardId}?${auth()}&idList=${cache.idListAprovacao}`,
      { method: "PUT" }
    );
    if (!moveRes.ok) {
      const errText = await moveRes.text();
      throw new Error(`Trello recusou mover o cartão: ${moveRes.status} ${errText}`);
    }

    console.log(`➡️  Chamado ${cardId} movido pra aguardando aprovação.`);

    // Gera o link de confirmação pra você copiar e mandar como quiser
    // (WhatsApp manual, e-mail etc.) — não mandamos nada automático.
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const token = gerarToken(cardId);
    const linkConfirmacao = `${baseUrl}/confirmar/${cardId}?token=${token}`;
    const solicitante = extrairSolicitante(descricao);

    res.json({
      success: true,
      linkConfirmacao,
      solicitante: solicitante ? solicitante.nome : null,
    });
  } catch (err) {
    console.error("Erro ao resolver chamado:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// A partir daqui, páginas/ações PÚBLICAS (sem senha de admin) — protegidas só
// pelo token, porque quem acessa é a pessoa que abriu o chamado, não você.

app.get("/confirmar/:id", async (req, res) => {
  const { id } = req.params;
  const { token } = req.query;

  if (!tokenValido(id, token)) {
    return res.type("html").send(paginaMensagem("Link inválido", "Esse link de confirmação não é válido."));
  }

  try {
    const cardRes = await fetch(`https://api.trello.com/1/cards/${id}?${auth()}&fields=name,desc,closed`);
    if (!cardRes.ok) throw new Error("Cartão não encontrado.");
    const card = await cardRes.json();

    res.type("html").send(paginaConfirmacao(card, token));
  } catch (err) {
    res.type("html").send(paginaMensagem("Erro", err.message));
  }
});

app.post("/api/confirmar/:id", express.json(), async (req, res) => {
  const { id } = req.params;
  const { token, decisao } = req.body || {};

  if (!tokenValido(id, token)) return res.status(401).json({ error: "Token inválido." });

  try {
    await garantirCache();
    const listaDestino = decisao === "reabrir" ? cache.idList : cache.idListFinalizada;
    const nomeLista = decisao === "reabrir" ? LISTA_DESTINO : LISTA_FINALIZADA;

    if (!listaDestino) {
      return res.status(500).json({ error: `Lista "${nomeLista}" não encontrada no board.` });
    }

    const moveRes = await fetch(`https://api.trello.com/1/cards/${id}?${auth()}&idList=${listaDestino}`, {
      method: "PUT",
    });
    if (!moveRes.ok) throw new Error(`Trello recusou mover o cartão: ${moveRes.status}`);

    if (decisao === "reabrir") {
      console.log(`🔁 Chamado ${id} reaberto pelo solicitante — não estava resolvido de verdade.`);
    }

    console.log(`✅ Chamado ${id} — decisão do solicitante: ${decisao}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Erro ao processar confirmação:", err.message);
    res.status(500).json({ error: err.message });
  }
});

function paginaMensagem(titulo, texto) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${titulo}</title>
  <style>body{background:#12141b;color:#e9eaee;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center;}
  .box{max-width:400px;} h1{font-size:22px;}</style></head>
  <body><div class="box"><h1>${titulo}</h1><p>${texto}</p></div></body></html>`;
}

function paginaConfirmacao(card, token) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Confirmar chamado</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#12141b; --panel:#1a1d27; --border:#2b2f3b; --text:#e9eaee; --muted:#8b93a7; --green:#61bd4f; --red:#eb5a46; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:'Inter',sans-serif; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
  .card { max-width:440px; width:100%; background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:28px; }
  h1 { font-size:20px; margin:0 0 6px; }
  .sub { color:var(--muted); font-size:14px; margin:0 0 20px; }
  .desc { white-space:pre-wrap; font-size:14px; color:var(--muted); background:#21252f; border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:22px; max-height:200px; overflow:auto; }
  button { width:100%; border:none; border-radius:8px; padding:13px; font-size:14.5px; font-weight:700; cursor:pointer; margin-bottom:10px; font-family:'Inter',sans-serif; }
  #btn-sim { background:var(--green); color:#0e1016; }
  #btn-nao { background:transparent; color:var(--red); border:1px solid var(--red); }
  #resultado { text-align:center; padding:20px 0; display:none; }
</style>
</head>
<body>
  <div class="card" id="tela">
    <h1>${card.name}</h1>
    <p class="sub">Seu chamado foi marcado como resolvido. Confirma que está tudo certo?</p>
    ${card.desc ? `<div class="desc">${card.desc}</div>` : ""}
    <button id="btn-sim">Sim, está resolvido ✅</button>
    <button id="btn-nao">Não, ainda não 🔁</button>
  </div>
  <div class="card" id="resultado"></div>

<script>
  async function decidir(decisao) {
    document.getElementById("tela").style.display = "none";
    const res = document.getElementById("resultado");
    res.style.display = "block";
    res.innerHTML = "<p>Enviando...</p>";
    try {
      const resp = await fetch("/api/confirmar/${card.id}", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "${token}", decisao }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Erro ao registrar sua resposta.");
      res.innerHTML = decisao === "reabrir"
        ? "<h1>Combinado 🔁</h1><p>Avisamos que ainda precisa de atenção.</p>"
        : "<h1>Show, valeu! ✅</h1><p>Chamado encerrado.</p>";
    } catch (err) {
      res.innerHTML = "<h1>Ops</h1><p>" + err.message + "</p>";
    }
  }
  document.getElementById("btn-sim").addEventListener("click", () => decidir("confirmar"));
  document.getElementById("btn-nao").addEventListener("click", () => decidir("reabrir"));
</script>
</body>
</html>`;
}

// Proxy pra exibir a imagem anexada no <img> do painel — a tag <img> não
// manda o header de senha, então aqui a senha vem por query param mesmo.
// Só serve pra imagem já vinculada a um cartão real do board, então o risco
// de vazamento é baixo mesmo assim.
app.get("/api/anexo", (req, res) => {
  if (req.query.senha !== ADMIN_PASSWORD) return res.status(401).send("não autorizado");

  const url = req.query.url || "";
  // Só redireciona pra URLs do próprio Trello — evita virar um redirecionador aberto.
  if (!url.startsWith("https://api.trello.com/") && !url.startsWith("https://trello-attachments.s3.amazonaws.com/")) {
    return res.status(400).send("URL inválida.");
  }

  const separador = url.includes("?") ? "&" : "?";
  res.redirect(302, `${url}${separador}${auth()}`);
});

app.get("/etiquetas", async (req, res) => {
  try {
    await garantirCache();
    res.json({ labels: cache.labels });
  } catch (err) {
    console.error("Erro ao buscar etiquetas:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/criar-chamado", upload.array("anexos", 6), async (req, res) => {
  try {
    await garantirCache();

    const { titulo, descricao, dataDesejada, etiquetaId, solicitanteNome, solicitanteWhatsapp } = req.body;

    if (!titulo || !titulo.trim()) {
      return res.status(400).json({ error: "Título é obrigatório." });
    }

    const agora = new Date();
    const abertoEm = agora.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

    const linhasDesc = [`Aberto em: ${abertoEm}`];
    if (solicitanteNome && solicitanteNome.trim()) {
      linhasDesc.push(`Solicitante: ${solicitanteNome.trim()} (${(solicitanteWhatsapp || "").trim()})`);
    }
    linhasDesc.push("", descricao && descricao.trim() ? descricao.trim() : "(sem detalhes adicionais)");
    const descCompleta = linhasDesc.join("\n");

    const params = new URLSearchParams({
      idList: cache.idList,
      name: titulo.trim(),
      desc: descCompleta,
    });
    if (dataDesejada) params.set("due", new Date(dataDesejada).toISOString());
    if (etiquetaId) params.set("idLabels", etiquetaId);

    const cardRes = await fetch(`https://api.trello.com/1/cards?${auth()}&${params.toString()}`, {
      method: "POST",
    });

    if (!cardRes.ok) {
      const errText = await cardRes.text();
      throw new Error(`Trello recusou a criação do cartão: ${cardRes.status} ${errText}`);
    }

    const card = await cardRes.json();
    console.log(`✅ Chamado criado: "${titulo}" — ${card.shortUrl}`);

    // Sobe cada anexo de imagem pro cartão recém-criado.
    const arquivos = req.files || [];
    for (const arquivo of arquivos) {
      try {
        const form = new FormData();
        form.append(
          "file",
          new Blob([arquivo.buffer], { type: arquivo.mimetype }),
          arquivo.originalname
        );

        const attRes = await fetch(
          `https://api.trello.com/1/cards/${card.id}/attachments?${auth()}`,
          { method: "POST", body: form }
        );

        if (!attRes.ok) {
          console.error(`Falha ao anexar "${arquivo.originalname}": ${attRes.status}`);
        } else {
          console.log(`  📎 Anexo enviado: ${arquivo.originalname}`);
        }
      } catch (attErr) {
        console.error(`Erro ao anexar "${arquivo.originalname}":`, attErr.message);
      }
    }

    res.json({ success: true, cardUrl: card.shortUrl });
  } catch (err) {
    console.error("Erro ao criar chamado:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PAGINA_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Abrir chamado</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #12141b;
    --panel: #1a1d27;
    --panel-2: #21252f;
    --border: #2b2f3b;
    --text: #e9eaee;
    --muted: #8b93a7;
    --green: #61bd4f;
    --yellow: #f2d600;
    --red: #eb5a46;
    --accent: #6e8fff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    padding: 48px 20px 80px;
  }
  main { width: 100%; max-width: 640px; }
  h1 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 28px;
    font-weight: 700;
    margin: 0 0 6px;
  }
  .subtitulo { color: var(--muted); font-size: 14px; margin: 0 0 32px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 28px;
  }
  label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    margin: 22px 0 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  label:first-of-type { margin-top: 0; }
  input[type="text"],
  input[type="date"],
  textarea {
    width: 100%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 11px 13px;
    color: var(--text);
    font-family: 'Inter', sans-serif;
    font-size: 15px;
    outline: none;
    transition: border-color 0.15s;
  }
  input[type="text"]:focus,
  input[type="date"]:focus,
  textarea:focus,
  .arquivo-label:focus-within {
    border-color: var(--accent);
  }
  textarea { min-height: 110px; resize: vertical; line-height: 1.5; }

  .etiquetas { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  .etiqueta {
    position: relative;
    border-radius: 8px;
    border: 2px solid transparent;
    padding: 9px 8px;
    cursor: pointer;
    text-align: center;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.3;
    color: #14161c;
    transition: transform 0.1s, border-color 0.15s;
    user-select: none;
  }
  .etiqueta:hover { transform: translateY(-1px); }
  .etiqueta input { position: absolute; opacity: 0; pointer-events: none; }
  .etiqueta[data-cor="green"]  { background: var(--green); }
  .etiqueta[data-cor="yellow"] { background: var(--yellow); }
  .etiqueta[data-cor="red"]    { background: var(--red); color: #fff; }
  .etiqueta.selecionada { border-color: #fff; }

  .arquivo-label {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--panel-2);
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 14px;
    cursor: pointer;
    font-size: 14px;
    color: var(--muted);
  }
  .arquivo-label input { display: none; }
  #lista-arquivos {
    margin-top: 8px;
    font-size: 13px;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  button[type="submit"] {
    margin-top: 28px;
    width: 100%;
    background: var(--accent);
    color: #0e1016;
    border: none;
    border-radius: 8px;
    padding: 14px;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    font-family: 'Inter', sans-serif;
    transition: opacity 0.15s;
  }
  button[type="submit"]:disabled { opacity: 0.55; cursor: not-allowed; }

  #mensagem {
    margin-top: 18px;
    padding: 14px 16px;
    border-radius: 8px;
    font-size: 14px;
    display: none;
    line-height: 1.5;
  }
  #mensagem.sucesso { display: block; background: rgba(97,189,79,0.12); border: 1px solid var(--green); color: #b7e6ac; }
  #mensagem.erro { display: block; background: rgba(235,90,70,0.12); border: 1px solid var(--red); color: #f3b3ab; }
  #mensagem a { color: inherit; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>Abrir chamado</h1>
  <p class="subtitulo">Cai direto na lista Tarefas Pendentes do board.</p>

  <form class="card" id="form-chamado">
    <label for="titulo">Título</label>
    <input type="text" id="titulo" name="titulo" placeholder="Resumo curto do que precisa" required maxlength="200" />

    <label for="solicitanteNome">Seu nome</label>
    <input type="text" id="solicitanteNome" name="solicitanteNome" placeholder="Como te chamamos" required maxlength="100" />

    <label for="solicitanteWhatsapp">Seu WhatsApp (opcional)</label>
    <input type="text" id="solicitanteWhatsapp" name="solicitanteWhatsapp" placeholder="DDI + DDD + número, ex: 5548999999999" maxlength="20" />
    <p style="color: var(--muted); font-size: 12.5px; margin: 6px 0 0;">Se deixar, avisamos por lá quando resolvermos.</p>

    <label for="descricao">Detalhes</label>
    <textarea id="descricao" name="descricao" placeholder="Descreva o problema ou o pedido com o máximo de detalhe possível"></textarea>

    <label>Prioridade</label>
    <div class="etiquetas" id="etiquetas"></div>

    <label for="dataDesejada">Data que você precisa disso</label>
    <input type="date" id="dataDesejada" name="dataDesejada" />

    <label for="anexos">Anexos (imagens)</label>
    <label class="arquivo-label" for="anexos">
      <span>📎</span>
      <span>Clique para escolher imagens (até 6, 8MB cada)</span>
      <input type="file" id="anexos" name="anexos" accept="image/*" multiple />
    </label>
    <div id="lista-arquivos"></div>

    <button type="submit" id="btn-enviar">Abrir chamado</button>
    <div id="mensagem"></div>
  </form>
</main>

<script>
  const etiquetasEl = document.getElementById("etiquetas");
  const form = document.getElementById("form-chamado");
  const btnEnviar = document.getElementById("btn-enviar");
  const mensagemEl = document.getElementById("mensagem");
  const anexosInput = document.getElementById("anexos");
  const listaArquivosEl = document.getElementById("lista-arquivos");

  // Busca as etiquetas reais do board pra não depender de IDs fixos no front.
  fetch("/etiquetas")
    .then((r) => r.json())
    .then((data) => {
      etiquetasEl.innerHTML = "";
      // Ignora etiquetas sem nome (cores padrão do Trello que ninguém renomeou).
      const labelsComNome = (data.labels || []).filter((l) => l.name && l.name.trim());
      labelsComNome.forEach((label, i) => {
        const wrapper = document.createElement("label");
        wrapper.className = "etiqueta";
        wrapper.dataset.cor = label.color || "grey";
        wrapper.innerHTML = \`
          <input type="radio" name="etiquetaId" value="\${label.id}" \${i === 0 ? "checked" : ""} />
          \${label.name || "(sem nome)"}
        \`;
        wrapper.addEventListener("click", () => {
          document.querySelectorAll(".etiqueta").forEach((e) => e.classList.remove("selecionada"));
          wrapper.classList.add("selecionada");
        });
        if (i === 0) wrapper.classList.add("selecionada");
        etiquetasEl.appendChild(wrapper);
      });
    })
    .catch(() => {
      etiquetasEl.innerHTML = '<p style="color: var(--muted); font-size: 13px;">Não foi possível carregar as etiquetas.</p>';
    });

  anexosInput.addEventListener("change", () => {
    listaArquivosEl.innerHTML = "";
    Array.from(anexosInput.files).forEach((f) => {
      const linha = document.createElement("div");
      linha.textContent = \`• \${f.name}\`;
      listaArquivosEl.appendChild(linha);
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btnEnviar.disabled = true;
    btnEnviar.textContent = "Enviando...";
    mensagemEl.className = "";
    mensagemEl.style.display = "none";

    const formData = new FormData(form);

    try {
      const res = await fetch("/criar-chamado", { method: "POST", body: formData });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Erro ao criar o chamado.");

      mensagemEl.className = "sucesso";
      mensagemEl.innerHTML = \`Chamado aberto! <a href="\${data.cardUrl}" target="_blank" rel="noopener">Ver no Trello →</a>\`;
      form.reset();
      listaArquivosEl.innerHTML = "";
      document.querySelectorAll(".etiqueta").forEach((e, i) => e.classList.toggle("selecionada", i === 0));
    } catch (err) {
      mensagemEl.className = "erro";
      mensagemEl.textContent = err.message;
    } finally {
      btnEnviar.disabled = false;
      btnEnviar.textContent = "Abrir chamado";
    }
  });
</script>
</body>
</html>
`;

app.get("/", (req, res) => {
  res.type("html").send(PAGINA_HTML);
});

const PAGINA_PAINEL = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Painel de chamados</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #12141b;
    --panel: #1a1d27;
    --panel-2: #21252f;
    --border: #2b2f3b;
    --text: #e9eaee;
    --muted: #8b93a7;
    --green: #61bd4f;
    --yellow: #f2d600;
    --red: #eb5a46;
    --accent: #6e8fff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    min-height: 100vh;
    padding: 48px 20px 80px;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 26px;
    font-weight: 700;
    margin: 0 0 6px;
  }
  .subtitulo { color: var(--muted); font-size: 14px; margin: 0 0 32px; }

  /* Tela de senha */
  #tela-login {
    max-width: 360px;
    margin: 80px auto 0;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 28px;
    text-align: center;
  }
  #tela-login input {
    width: 100%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 11px 13px;
    color: var(--text);
    font-size: 15px;
    margin: 16px 0;
    outline: none;
  }
  #tela-login input:focus { border-color: var(--accent); }
  #tela-login button, .btn-resolver {
    background: var(--accent);
    color: #0e1016;
    border: none;
    border-radius: 8px;
    padding: 11px 16px;
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
    font-family: 'Inter', sans-serif;
  }
  #erro-login { color: var(--red); font-size: 13px; margin-top: 10px; display: none; }

  /* Lista de chamados */
  #painel { display: none; }
  .chamado {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 14px;
  }
  .chamado h3 { margin: 0 0 8px; font-size: 17px; font-weight: 600; }
  .chamado p { margin: 0 0 12px; color: var(--muted); font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
  .imagens { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .imagens img {
    width: 84px; height: 84px; object-fit: cover; border-radius: 8px;
    border: 1px solid var(--border); display: block;
  }
  .feedback { font-size: 13px; color: var(--green); margin-top: 10px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; align-items: center; }
  .chip {
    font-size: 11.5px;
    font-weight: 600;
    padding: 4px 9px;
    border-radius: 6px;
    color: #14161c;
  }
  .chip.data { background: var(--panel-2); color: var(--muted); border: 1px solid var(--border); }
  .chip[data-cor="green"]  { background: var(--green); }
  .chip[data-cor="yellow"] { background: var(--yellow); }
  .chip[data-cor="red"]    { background: var(--red); color: #fff; }
  .acoes { display: flex; gap: 10px; align-items: center; }
  .acoes a { color: var(--accent); font-size: 13px; text-decoration: none; }
  #vazio { color: var(--muted); text-align: center; padding: 40px 0; display: none; }
  #carregando { color: var(--muted); text-align: center; padding: 40px 0; }
</style>
</head>
<body>
<main>
  <div id="tela-login">
    <h1 style="font-size:20px;">Entrar no painel</h1>
    <input type="password" id="senha" placeholder="Senha" autofocus />
    <button onclick="entrar()">Entrar</button>
    <div id="erro-login">Senha incorreta.</div>
  </div>

  <div id="painel">
    <h1>Chamados em aberto</h1>
    <p class="subtitulo">Marcar como resolvido move o cartão pra lista Finalizadas no Trello — nada é apagado de verdade.</p>
    <div id="carregando">Carregando...</div>
    <div id="vazio">Nenhum chamado em aberto. 🎉</div>
    <div id="lista"></div>
  </div>
</main>

<script>
  let senhaAtual = sessionStorage.getItem("painel_senha") || "";

  async function chamarApi(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { ...(opts.headers || {}), "x-admin-password": senhaAtual },
    });
    if (res.status === 401) throw new Error("senha_invalida");
    if (!res.ok) throw new Error((await res.json()).error || "Erro na requisição.");
    return res.json();
  }

  async function entrar() {
    senhaAtual = document.getElementById("senha").value;
    try {
      await carregarChamados();
      sessionStorage.setItem("painel_senha", senhaAtual);
      document.getElementById("tela-login").style.display = "none";
      document.getElementById("painel").style.display = "block";
    } catch (err) {
      document.getElementById("erro-login").style.display = "block";
    }
  }

  async function carregarChamados() {
    const data = await chamarApi("/api/chamados");
    const listaEl = document.getElementById("lista");
    const vazioEl = document.getElementById("vazio");
    document.getElementById("carregando").style.display = "none";
    listaEl.innerHTML = "";

    if (!data.chamados.length) {
      vazioEl.style.display = "block";
      return;
    }
    vazioEl.style.display = "none";

    data.chamados.forEach((c) => {
      const div = document.createElement("div");
      div.className = "chamado";
      const dataFmt = c.dataDesejada
        ? new Date(c.dataDesejada).toLocaleDateString("pt-BR")
        : null;

      div.innerHTML = \`
        <h3>\${c.titulo}</h3>
        \${c.descricao ? \`<p>\${c.descricao}</p>\` : ""}
        \${c.imagens && c.imagens.length ? \`<div class="imagens">\${c.imagens.map((img) =>
          \`<a href="/api/anexo?url=\${encodeURIComponent(img.url)}&senha=\${encodeURIComponent(senhaAtual)}" target="_blank" rel="noopener">
            <img src="/api/anexo?url=\${encodeURIComponent(img.url)}&senha=\${encodeURIComponent(senhaAtual)}" alt="\${img.nome || "anexo"}" />
          </a>\`
        ).join("")}</div>\` : ""}
        <div class="meta">
          \${c.etiquetas.map((e) => \`<span class="chip" data-cor="\${e.color}">\${e.name}</span>\`).join("")}
          \${dataFmt ? \`<span class="chip data">Precisa até \${dataFmt}</span>\` : ""}
        </div>
        <div class="acoes">
          <button class="btn-resolver" data-id="\${c.id}">Marcar como resolvido</button>
          <a href="\${c.url}" target="_blank" rel="noopener">Ver no Trello →</a>
        </div>
        <div class="feedback" style="display:none;"></div>
      \`;
      div.dataset.titulo = c.titulo;
      div.dataset.descricao = c.descricao || "";
      listaEl.appendChild(div);
    });

    document.querySelectorAll(".btn-resolver").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Movendo...";
        const cardEl = btn.closest(".chamado");
        try {
          const data = await chamarApi(\`/api/chamados/\${btn.dataset.id}/resolver\`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ titulo: cardEl.dataset.titulo, descricao: cardEl.dataset.descricao }),
          });
          const feedback = cardEl.querySelector(".feedback");
          feedback.style.display = "block";
          feedback.innerHTML = \`
            <p style="margin: 0 0 8px;">
              Movido pra aguardando aprovação\${data.solicitante ? \` — avise <strong>\${data.solicitante}</strong>\` : ""}
              com este link, pra confirmar que ficou certo:
            </p>
            <input readonly id="link-\${btn.dataset.id}" value="\${data.linkConfirmacao}"
              style="width:100%; background:var(--panel-2); border:1px solid var(--border); border-radius:6px; padding:8px 10px; color:var(--text); font-size:12.5px; margin-bottom:8px;" />
            <div style="display:flex; gap:8px;">
              <button type="button" class="btn-copiar" data-link="\${data.linkConfirmacao}" style="flex:1; background:var(--panel-2); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:8px; font-size:13px; cursor:pointer;">Copiar link</button>
              <button type="button" class="btn-concluir" style="flex:1; background:var(--accent); color:#0e1016; border:none; border-radius:6px; padding:8px; font-size:13px; font-weight:700; cursor:pointer;">Já mandei ✓</button>
            </div>
          \`;
          btn.remove();
          feedback.querySelector(".btn-copiar").addEventListener("click", (e) => {
            navigator.clipboard.writeText(e.target.dataset.link);
            e.target.textContent = "Copiado!";
            setTimeout(() => (e.target.textContent = "Copiar link"), 1500);
          });
          feedback.querySelector(".btn-concluir").addEventListener("click", () => {
            cardEl.remove();
            if (!document.querySelectorAll(".chamado").length) {
              document.getElementById("vazio").style.display = "block";
            }
          });
        } catch (err) {
          btn.disabled = false;
          btn.textContent = "Marcar como resolvido";
          alert("Erro: " + err.message);
        }
      });
    });
  }

  document.getElementById("senha").addEventListener("keydown", (e) => {
    if (e.key === "Enter") entrar();
  });

  // Se já tem senha guardada nessa aba, tenta entrar direto.
  if (senhaAtual) entrar();
</script>
</body>
</html>
`;

app.get("/painel", (req, res) => {
  res.type("html").send(PAGINA_PAINEL);
});

app.listen(PORT, "0.0.0.0", () => console.log(`Servidor rodando na porta ${PORT}`));

const LISTA_DESTINO = process.env.TRELLO_LISTA_DESTINO || "TAREFAS PENDENTES";
// Nome exato da lista pra onde um chamado vai quando você marca como resolvido.
const LISTA_FINALIZADA = process.env.TRELLO_LISTA_FINALIZADA || "FINALIZADAS";
// Nome exato da lista pra onde o chamado vai enquanto espera a confirmação
// de quem abriu (antes de virar "finalizado" de vez).
const LISTA_APROVACAO = process.env.TRELLO_LISTA_APROVACAO || "AGUARDANDO APROVAÇÃO";
// Senha do seu painel privado (/painel). Sem isso configurado, o painel fica bloqueado.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!TRELLO_API_KEY || !TRELLO_TOKEN || !TRELLO_BOARD_ID) {
  console.error("⚠️  Faltam variáveis de ambiente: TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID");
}

const auth = () => `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;

// Cache simples em memória do id da lista e das etiquetas do board.
// Evita bater na API do Trello a cada chamado aberto.
let cache = { idList: null, idListFinalizada: null, idListAprovacao: null, labels: null, carregadoEm: 0 };
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

async function carregarCache() {
  const [listsRes, labelsRes] = await Promise.all([
    fetch(`https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/lists?${auth()}`),
    fetch(`https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/labels?${auth()}&limit=1000`),
  ]);

  if (!listsRes.ok) throw new Error(`Falha ao buscar listas do Trello: ${listsRes.status}`);
  if (!labelsRes.ok) throw new Error(`Falha ao buscar etiquetas do Trello: ${labelsRes.status}`);

  const lists = await listsRes.json();
  const labels = await labelsRes.json();

  const norm = (s) => s.trim().toLowerCase();

  const lista = lists.find((l) => norm(l.name) === norm(LISTA_DESTINO));
  if (!lista) {
    throw new Error(
      `Lista "${LISTA_DESTINO}" não encontrada no board. Listas disponíveis: ${lists.map((l) => l.name).join(", ")}`
    );
  }

  const listaFinalizada = lists.find((l) => norm(l.name) === norm(LISTA_FINALIZADA));
  if (!listaFinalizada) {
    console.warn(
      `⚠️  Lista "${LISTA_FINALIZADA}" não encontrada — o botão de resolver no /painel vai falhar até isso existir.`
    );
  }

  const listaAprovacao = lists.find((l) => norm(l.name) === norm(LISTA_APROVACAO));
  if (!listaAprovacao) {
    console.warn(
      `⚠️  Lista "${LISTA_APROVACAO}" não encontrada — a etapa de confirmação com quem abriu o chamado vai falhar até isso existir.`
    );
  }

  cache = {
    idList: lista.id,
    idListFinalizada: listaFinalizada ? listaFinalizada.id : null,
    idListAprovacao: listaAprovacao ? listaAprovacao.id : null,
    // Mantém id + nome + cor pra devolver ao front sem chamar o Trello de novo.
    labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    carregadoEm: Date.now(),
  };

  console.log(`✅ Cache carregado — lista "${lista.name}" (${lista.id}), ${labels.length} etiquetas`);
}

async function garantirCache() {
  if (!cache.idList || Date.now() - cache.carregadoEm > CACHE_TTL_MS) {
    await carregarCache();
  }
}

// Extrai "Solicitante: Nome (telefone)" da descrição do cartão — é assim que
// guardamos quem abriu o chamado, já que o formulário público não tem login.
function extrairSolicitante(desc) {
  const m = /^Solicitante: (.+?) \((.*?)\)\s*$/m.exec(desc || "");
  return m ? { nome: m[1].trim(), telefone: m[2].trim() } : null;
}

// Token curto pra proteger os links de confirmação que vão por WhatsApp —
// sem precisar guardar nada em banco, só recalcula e compara.
function gerarToken(cardId) {
  return crypto
    .createHmac("sha256", ADMIN_PASSWORD || "segredo-padrao-troque-a-senha")
    .update(cardId)
    .digest("hex")
    .slice(0, 20);
}
function tokenValido(cardId, token) {
  return typeof token === "string" && token === gerarToken(cardId);
}

// Etiquetas para o formulário — devolve o que o front precisa pra desenhar
// as opções coloridas.
// Protege as rotas do painel. Sem ADMIN_PASSWORD configurada, ninguém entra.
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: "Painel não configurado (falta ADMIN_PASSWORD no servidor)." });
  }
  const senha = req.headers["x-admin-password"];
  if (senha !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Senha incorreta." });
  }
  next();
}

// Lista os chamados em aberto (qualquer lista do board, menos a de finalizados).
app.get("/api/chamados", requireAdmin, async (req, res) => {
  try {
    await garantirCache();

    const camposCartao = "name,desc,due,idList,shortUrl,idLabels,dateLastActivity";
    const cardsRes = await fetch(
      `https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/cards/open?${auth()}&fields=${camposCartao}&attachments=true&attachment_fields=id,name,mimeType`
    );
    if (!cardsRes.ok) throw new Error(`Falha ao buscar cartões: ${cardsRes.status}`);
    const cards = await cardsRes.json();

    const abertos = cards
      .filter((c) => c.idList !== cache.idListFinalizada && c.idList !== cache.idListAprovacao)
      .map((c) => ({
        id: c.id,
        titulo: c.name,
        descricao: c.desc,
        dataDesejada: c.due,
        url: c.shortUrl,
        ultimaAtividade: c.dateLastActivity,
        etiquetas: (c.idLabels || [])
          .map((id) => cache.labels.find((l) => l.id === id))
          .filter(Boolean),
        imagens: (c.attachments || [])
          .filter((a) => a.mimeType && a.mimeType.startsWith("image/"))
          .map((a) => ({ id: a.id, nome: a.name })),
      }))
      // Mais recentes primeiro.
      .sort((a, b) => new Date(b.ultimaAtividade) - new Date(a.ultimaAtividade));

    res.json({ chamados: abertos });
  } catch (err) {
    console.error("Erro ao listar chamados:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Marca um chamado como resolvido: move o cartão pra lista de finalizados.
// Não apaga de verdade — o cartão continua existindo, só sai da fila ativa.
app.post("/api/chamados/:id/resolver", requireAdmin, express.json(), async (req, res) => {
  try {
    await garantirCache();

    if (!cache.idListAprovacao) {
      return res.status(500).json({
        error: `Lista "${LISTA_APROVACAO}" não encontrada no board — configure TRELLO_LISTA_APROVACAO ou crie a lista.`,
      });
    }

    const cardId = req.params.id;
    const descricao = (req.body && req.body.descricao) || "";
    const titulo = (req.body && req.body.titulo) || "";

    const moveRes = await fetch(
      `https://api.trello.com/1/cards/${cardId}?${auth()}&idList=${cache.idListAprovacao}`,
      { method: "PUT" }
    );
    if (!moveRes.ok) {
      const errText = await moveRes.text();
      throw new Error(`Trello recusou mover o cartão: ${moveRes.status} ${errText}`);
    }

    console.log(`➡️  Chamado ${cardId} movido pra aguardando aprovação.`);

    // Gera o link de confirmação pra você copiar e mandar como quiser
    // (WhatsApp manual, e-mail etc.) — não mandamos nada automático.
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const token = gerarToken(cardId);
    const linkConfirmacao = `${baseUrl}/confirmar/${cardId}?token=${token}`;
    const solicitante = extrairSolicitante(descricao);

    res.json({
      success: true,
      linkConfirmacao,
      solicitante: solicitante ? solicitante.nome : null,
    });
  } catch (err) {
    console.error("Erro ao resolver chamado:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// A partir daqui, páginas/ações PÚBLICAS (sem senha de admin) — protegidas só
// pelo token, porque quem acessa é a pessoa que abriu o chamado, não você.

app.get("/confirmar/:id", async (req, res) => {
  const { id } = req.params;
  const { token } = req.query;

  if (!tokenValido(id, token)) {
    return res.type("html").send(paginaMensagem("Link inválido", "Esse link de confirmação não é válido."));
  }

  try {
    const cardRes = await fetch(`https://api.trello.com/1/cards/${id}?${auth()}&fields=name,desc,closed`);
    if (!cardRes.ok) throw new Error("Cartão não encontrado.");
    const card = await cardRes.json();

    res.type("html").send(paginaConfirmacao(card, token));
  } catch (err) {
    res.type("html").send(paginaMensagem("Erro", err.message));
  }
});

app.post("/api/confirmar/:id", express.json(), async (req, res) => {
  const { id } = req.params;
  const { token, decisao } = req.body || {};

  if (!tokenValido(id, token)) return res.status(401).json({ error: "Token inválido." });

  try {
    await garantirCache();
    const listaDestino = decisao === "reabrir" ? cache.idList : cache.idListFinalizada;
    const nomeLista = decisao === "reabrir" ? LISTA_DESTINO : LISTA_FINALIZADA;

    if (!listaDestino) {
      return res.status(500).json({ error: `Lista "${nomeLista}" não encontrada no board.` });
    }

    const moveRes = await fetch(`https://api.trello.com/1/cards/${id}?${auth()}&idList=${listaDestino}`, {
      method: "PUT",
    });
    if (!moveRes.ok) throw new Error(`Trello recusou mover o cartão: ${moveRes.status}`);

    if (decisao === "reabrir") {
      console.log(`🔁 Chamado ${id} reaberto pelo solicitante — não estava resolvido de verdade.`);
    }

    console.log(`✅ Chamado ${id} — decisão do solicitante: ${decisao}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Erro ao processar confirmação:", err.message);
    res.status(500).json({ error: err.message });
  }
});

function paginaMensagem(titulo, texto) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${titulo}</title>
  <style>body{background:#12141b;color:#e9eaee;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center;}
  .box{max-width:400px;} h1{font-size:22px;}</style></head>
  <body><div class="box"><h1>${titulo}</h1><p>${texto}</p></div></body></html>`;
}

function paginaConfirmacao(card, token) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Confirmar chamado</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#12141b; --panel:#1a1d27; --border:#2b2f3b; --text:#e9eaee; --muted:#8b93a7; --green:#61bd4f; --red:#eb5a46; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:'Inter',sans-serif; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
  .card { max-width:440px; width:100%; background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:28px; }
  h1 { font-size:20px; margin:0 0 6px; }
  .sub { color:var(--muted); font-size:14px; margin:0 0 20px; }
  .desc { white-space:pre-wrap; font-size:14px; color:var(--muted); background:#21252f; border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:22px; max-height:200px; overflow:auto; }
  button { width:100%; border:none; border-radius:8px; padding:13px; font-size:14.5px; font-weight:700; cursor:pointer; margin-bottom:10px; font-family:'Inter',sans-serif; }
  #btn-sim { background:var(--green); color:#0e1016; }
  #btn-nao { background:transparent; color:var(--red); border:1px solid var(--red); }
  #resultado { text-align:center; padding:20px 0; display:none; }
</style>
</head>
<body>
  <div class="card" id="tela">
    <h1>${card.name}</h1>
    <p class="sub">Seu chamado foi marcado como resolvido. Confirma que está tudo certo?</p>
    ${card.desc ? `<div class="desc">${card.desc}</div>` : ""}
    <button id="btn-sim">Sim, está resolvido ✅</button>
    <button id="btn-nao">Não, ainda não 🔁</button>
  </div>
  <div class="card" id="resultado"></div>

<script>
  async function decidir(decisao) {
    document.getElementById("tela").style.display = "none";
    const res = document.getElementById("resultado");
    res.style.display = "block";
    res.innerHTML = "<p>Enviando...</p>";
    try {
      const resp = await fetch("/api/confirmar/${card.id}", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "${token}", decisao }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Erro ao registrar sua resposta.");
      res.innerHTML = decisao === "reabrir"
        ? "<h1>Combinado 🔁</h1><p>Avisamos que ainda precisa de atenção.</p>"
        : "<h1>Show, valeu! ✅</h1><p>Chamado encerrado.</p>";
    } catch (err) {
      res.innerHTML = "<h1>Ops</h1><p>" + err.message + "</p>";
    }
  }
  document.getElementById("btn-sim").addEventListener("click", () => decidir("confirmar"));
  document.getElementById("btn-nao").addEventListener("click", () => decidir("reabrir"));
</script>
</body>
</html>`;
}

// Proxy pra exibir a imagem anexada no <img> do painel — a tag <img> não
// manda o header de senha, então aqui a senha vem por query param mesmo.
// Só serve pra imagem já vinculada a um cartão real do board, então o risco
// de vazamento é baixo mesmo assim.
app.get("/api/anexo/:cardId/:attachmentId", async (req, res) => {
  if (req.query.senha !== ADMIN_PASSWORD) return res.status(401).send("não autorizado");
  try {
    const attRes = await fetch(
      `https://api.trello.com/1/cards/${req.params.cardId}/attachments/${req.params.attachmentId}?${auth()}`
    );
    if (!attRes.ok) throw new Error(`Falha ao buscar anexo: ${attRes.status}`);
    const att = await attRes.json();

    const fileRes = await fetch(`${att.url}?${auth()}`);
    if (!fileRes.ok) throw new Error(`Falha ao baixar anexo: ${fileRes.status}`);

    res.set("Content-Type", att.mimeType || "application/octet-stream");
    res.send(Buffer.from(await fileRes.arrayBuffer()));
  } catch (err) {
    console.error("Erro ao servir anexo:", err.message);
    res.status(500).send("Erro ao carregar imagem.");
  }
});

app.get("/etiquetas", async (req, res) => {
  try {
    await garantirCache();
    res.json({ labels: cache.labels });
  } catch (err) {
    console.error("Erro ao buscar etiquetas:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/criar-chamado", upload.array("anexos", 6), async (req, res) => {
  try {
    await garantirCache();

    const { titulo, descricao, dataDesejada, etiquetaId, solicitanteNome, solicitanteWhatsapp } = req.body;

    if (!titulo || !titulo.trim()) {
      return res.status(400).json({ error: "Título é obrigatório." });
    }

    const agora = new Date();
    const abertoEm = agora.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

    const linhasDesc = [`Aberto em: ${abertoEm}`];
    if (solicitanteNome && solicitanteNome.trim()) {
      linhasDesc.push(`Solicitante: ${solicitanteNome.trim()} (${(solicitanteWhatsapp || "").trim()})`);
    }
    linhasDesc.push("", descricao && descricao.trim() ? descricao.trim() : "(sem detalhes adicionais)");
    const descCompleta = linhasDesc.join("\n");

    const params = new URLSearchParams({
      idList: cache.idList,
      name: titulo.trim(),
      desc: descCompleta,
    });
    if (dataDesejada) params.set("due", new Date(dataDesejada).toISOString());
    if (etiquetaId) params.set("idLabels", etiquetaId);

    const cardRes = await fetch(`https://api.trello.com/1/cards?${auth()}&${params.toString()}`, {
      method: "POST",
    });

    if (!cardRes.ok) {
      const errText = await cardRes.text();
      throw new Error(`Trello recusou a criação do cartão: ${cardRes.status} ${errText}`);
    }

    const card = await cardRes.json();
    console.log(`✅ Chamado criado: "${titulo}" — ${card.shortUrl}`);

    // Sobe cada anexo de imagem pro cartão recém-criado.
    const arquivos = req.files || [];
    for (const arquivo of arquivos) {
      try {
        const form = new FormData();
        form.append(
          "file",
          new Blob([arquivo.buffer], { type: arquivo.mimetype }),
          arquivo.originalname
        );

        const attRes = await fetch(
          `https://api.trello.com/1/cards/${card.id}/attachments?${auth()}`,
          { method: "POST", body: form }
        );

        if (!attRes.ok) {
          console.error(`Falha ao anexar "${arquivo.originalname}": ${attRes.status}`);
        } else {
          console.log(`  📎 Anexo enviado: ${arquivo.originalname}`);
        }
      } catch (attErr) {
        console.error(`Erro ao anexar "${arquivo.originalname}":`, attErr.message);
      }
    }

    res.json({ success: true, cardUrl: card.shortUrl });
  } catch (err) {
    console.error("Erro ao criar chamado:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PAGINA_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Abrir chamado</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #12141b;
    --panel: #1a1d27;
    --panel-2: #21252f;
    --border: #2b2f3b;
    --text: #e9eaee;
    --muted: #8b93a7;
    --green: #61bd4f;
    --yellow: #f2d600;
    --red: #eb5a46;
    --accent: #6e8fff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    padding: 48px 20px 80px;
  }
  main { width: 100%; max-width: 640px; }
  h1 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 28px;
    font-weight: 700;
    margin: 0 0 6px;
  }
  .subtitulo { color: var(--muted); font-size: 14px; margin: 0 0 32px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 28px;
  }
  label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    margin: 22px 0 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  label:first-of-type { margin-top: 0; }
  input[type="text"],
  input[type="date"],
  textarea {
    width: 100%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 11px 13px;
    color: var(--text);
    font-family: 'Inter', sans-serif;
    font-size: 15px;
    outline: none;
    transition: border-color 0.15s;
  }
  input[type="text"]:focus,
  input[type="date"]:focus,
  textarea:focus,
  .arquivo-label:focus-within {
    border-color: var(--accent);
  }
  textarea { min-height: 110px; resize: vertical; line-height: 1.5; }

  .etiquetas { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
  .etiqueta {
    position: relative;
    border-radius: 8px;
    border: 2px solid transparent;
    padding: 9px 8px;
    cursor: pointer;
    text-align: center;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.3;
    color: #14161c;
    transition: transform 0.1s, border-color 0.15s;
    user-select: none;
  }
  .etiqueta:hover { transform: translateY(-1px); }
  .etiqueta input { position: absolute; opacity: 0; pointer-events: none; }
  .etiqueta[data-cor="green"]  { background: var(--green); }
  .etiqueta[data-cor="yellow"] { background: var(--yellow); }
  .etiqueta[data-cor="red"]    { background: var(--red); color: #fff; }
  .etiqueta.selecionada { border-color: #fff; }

  .arquivo-label {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--panel-2);
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 14px;
    cursor: pointer;
    font-size: 14px;
    color: var(--muted);
  }
  .arquivo-label input { display: none; }
  #lista-arquivos {
    margin-top: 8px;
    font-size: 13px;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  button[type="submit"] {
    margin-top: 28px;
    width: 100%;
    background: var(--accent);
    color: #0e1016;
    border: none;
    border-radius: 8px;
    padding: 14px;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    font-family: 'Inter', sans-serif;
    transition: opacity 0.15s;
  }
  button[type="submit"]:disabled { opacity: 0.55; cursor: not-allowed; }

  #mensagem {
    margin-top: 18px;
    padding: 14px 16px;
    border-radius: 8px;
    font-size: 14px;
    display: none;
    line-height: 1.5;
  }
  #mensagem.sucesso { display: block; background: rgba(97,189,79,0.12); border: 1px solid var(--green); color: #b7e6ac; }
  #mensagem.erro { display: block; background: rgba(235,90,70,0.12); border: 1px solid var(--red); color: #f3b3ab; }
  #mensagem a { color: inherit; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>Abrir chamado</h1>
  <p class="subtitulo">Cai direto na lista Tarefas Pendentes do board.</p>

  <form class="card" id="form-chamado">
    <label for="titulo">Título</label>
    <input type="text" id="titulo" name="titulo" placeholder="Resumo curto do que precisa" required maxlength="200" />

    <label for="solicitanteNome">Seu nome</label>
    <input type="text" id="solicitanteNome" name="solicitanteNome" placeholder="Como te chamamos" required maxlength="100" />

    <label for="solicitanteWhatsapp">Seu WhatsApp (opcional)</label>
    <input type="text" id="solicitanteWhatsapp" name="solicitanteWhatsapp" placeholder="DDI + DDD + número, ex: 5548999999999" maxlength="20" />
    <p style="color: var(--muted); font-size: 12.5px; margin: 6px 0 0;">Se deixar, avisamos por lá quando resolvermos.</p>

    <label for="descricao">Detalhes</label>
    <textarea id="descricao" name="descricao" placeholder="Descreva o problema ou o pedido com o máximo de detalhe possível"></textarea>

    <label>Prioridade</label>
    <div class="etiquetas" id="etiquetas"></div>

    <label for="dataDesejada">Data que você precisa disso</label>
    <input type="date" id="dataDesejada" name="dataDesejada" />

    <label for="anexos">Anexos (imagens)</label>
    <label class="arquivo-label" for="anexos">
      <span>📎</span>
      <span>Clique para escolher imagens (até 6, 8MB cada)</span>
      <input type="file" id="anexos" name="anexos" accept="image/*" multiple />
    </label>
    <div id="lista-arquivos"></div>

    <button type="submit" id="btn-enviar">Abrir chamado</button>
    <div id="mensagem"></div>
  </form>
</main>

<script>
  const etiquetasEl = document.getElementById("etiquetas");
  const form = document.getElementById("form-chamado");
  const btnEnviar = document.getElementById("btn-enviar");
  const mensagemEl = document.getElementById("mensagem");
  const anexosInput = document.getElementById("anexos");
  const listaArquivosEl = document.getElementById("lista-arquivos");

  // Busca as etiquetas reais do board pra não depender de IDs fixos no front.
  fetch("/etiquetas")
    .then((r) => r.json())
    .then((data) => {
      etiquetasEl.innerHTML = "";
      // Ignora etiquetas sem nome (cores padrão do Trello que ninguém renomeou).
      const labelsComNome = (data.labels || []).filter((l) => l.name && l.name.trim());
      labelsComNome.forEach((label, i) => {
        const wrapper = document.createElement("label");
        wrapper.className = "etiqueta";
        wrapper.dataset.cor = label.color || "grey";
        wrapper.innerHTML = \`
          <input type="radio" name="etiquetaId" value="\${label.id}" \${i === 0 ? "checked" : ""} />
          \${label.name || "(sem nome)"}
        \`;
        wrapper.addEventListener("click", () => {
          document.querySelectorAll(".etiqueta").forEach((e) => e.classList.remove("selecionada"));
          wrapper.classList.add("selecionada");
        });
        if (i === 0) wrapper.classList.add("selecionada");
        etiquetasEl.appendChild(wrapper);
      });
    })
    .catch(() => {
      etiquetasEl.innerHTML = '<p style="color: var(--muted); font-size: 13px;">Não foi possível carregar as etiquetas.</p>';
    });

  anexosInput.addEventListener("change", () => {
    listaArquivosEl.innerHTML = "";
    Array.from(anexosInput.files).forEach((f) => {
      const linha = document.createElement("div");
      linha.textContent = \`• \${f.name}\`;
      listaArquivosEl.appendChild(linha);
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btnEnviar.disabled = true;
    btnEnviar.textContent = "Enviando...";
    mensagemEl.className = "";
    mensagemEl.style.display = "none";

    const formData = new FormData(form);

    try {
      const res = await fetch("/criar-chamado", { method: "POST", body: formData });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Erro ao criar o chamado.");

      mensagemEl.className = "sucesso";
      mensagemEl.innerHTML = \`Chamado aberto! <a href="\${data.cardUrl}" target="_blank" rel="noopener">Ver no Trello →</a>\`;
      form.reset();
      listaArquivosEl.innerHTML = "";
      document.querySelectorAll(".etiqueta").forEach((e, i) => e.classList.toggle("selecionada", i === 0));
    } catch (err) {
      mensagemEl.className = "erro";
      mensagemEl.textContent = err.message;
    } finally {
      btnEnviar.disabled = false;
      btnEnviar.textContent = "Abrir chamado";
    }
  });
</script>
</body>
</html>
`;

app.get("/", (req, res) => {
  res.type("html").send(PAGINA_HTML);
});

const PAGINA_PAINEL = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Painel de chamados</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #12141b;
    --panel: #1a1d27;
    --panel-2: #21252f;
    --border: #2b2f3b;
    --text: #e9eaee;
    --muted: #8b93a7;
    --green: #61bd4f;
    --yellow: #f2d600;
    --red: #eb5a46;
    --accent: #6e8fff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    min-height: 100vh;
    padding: 48px 20px 80px;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 26px;
    font-weight: 700;
    margin: 0 0 6px;
  }
  .subtitulo { color: var(--muted); font-size: 14px; margin: 0 0 32px; }

  /* Tela de senha */
  #tela-login {
    max-width: 360px;
    margin: 80px auto 0;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 28px;
    text-align: center;
  }
  #tela-login input {
    width: 100%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 11px 13px;
    color: var(--text);
    font-size: 15px;
    margin: 16px 0;
    outline: none;
  }
  #tela-login input:focus { border-color: var(--accent); }
  #tela-login button, .btn-resolver {
    background: var(--accent);
    color: #0e1016;
    border: none;
    border-radius: 8px;
    padding: 11px 16px;
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
    font-family: 'Inter', sans-serif;
  }
  #erro-login { color: var(--red); font-size: 13px; margin-top: 10px; display: none; }

  /* Lista de chamados */
  #painel { display: none; }
  .chamado {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 14px;
  }
  .chamado h3 { margin: 0 0 8px; font-size: 17px; font-weight: 600; }
  .chamado p { margin: 0 0 12px; color: var(--muted); font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
  .imagens { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .imagens img {
    width: 84px; height: 84px; object-fit: cover; border-radius: 8px;
    border: 1px solid var(--border); display: block;
  }
  .feedback { font-size: 13px; color: var(--green); margin-top: 10px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; align-items: center; }
  .chip {
    font-size: 11.5px;
    font-weight: 600;
    padding: 4px 9px;
    border-radius: 6px;
    color: #14161c;
  }
  .chip.data { background: var(--panel-2); color: var(--muted); border: 1px solid var(--border); }
  .chip[data-cor="green"]  { background: var(--green); }
  .chip[data-cor="yellow"] { background: var(--yellow); }
  .chip[data-cor="red"]    { background: var(--red); color: #fff; }
  .acoes { display: flex; gap: 10px; align-items: center; }
  .acoes a { color: var(--accent); font-size: 13px; text-decoration: none; }
  #vazio { color: var(--muted); text-align: center; padding: 40px 0; display: none; }
  #carregando { color: var(--muted); text-align: center; padding: 40px 0; }
</style>
</head>
<body>
<main>
  <div id="tela-login">
    <h1 style="font-size:20px;">Entrar no painel</h1>
    <input type="password" id="senha" placeholder="Senha" autofocus />
    <button onclick="entrar()">Entrar</button>
    <div id="erro-login">Senha incorreta.</div>
  </div>

  <div id="painel">
    <h1>Chamados em aberto</h1>
    <p class="subtitulo">Marcar como resolvido move o cartão pra lista Finalizadas no Trello — nada é apagado de verdade.</p>
    <div id="carregando">Carregando...</div>
    <div id="vazio">Nenhum chamado em aberto. 🎉</div>
    <div id="lista"></div>
  </div>
</main>

<script>
  let senhaAtual = sessionStorage.getItem("painel_senha") || "";

  async function chamarApi(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { ...(opts.headers || {}), "x-admin-password": senhaAtual },
    });
    if (res.status === 401) throw new Error("senha_invalida");
    if (!res.ok) throw new Error((await res.json()).error || "Erro na requisição.");
    return res.json();
  }

  async function entrar() {
    senhaAtual = document.getElementById("senha").value;
    try {
      await carregarChamados();
      sessionStorage.setItem("painel_senha", senhaAtual);
      document.getElementById("tela-login").style.display = "none";
      document.getElementById("painel").style.display = "block";
    } catch (err) {
      document.getElementById("erro-login").style.display = "block";
    }
  }

  async function carregarChamados() {
    const data = await chamarApi("/api/chamados");
    const listaEl = document.getElementById("lista");
    const vazioEl = document.getElementById("vazio");
    document.getElementById("carregando").style.display = "none";
    listaEl.innerHTML = "";

    if (!data.chamados.length) {
      vazioEl.style.display = "block";
      return;
    }
    vazioEl.style.display = "none";

    data.chamados.forEach((c) => {
      const div = document.createElement("div");
      div.className = "chamado";
      const dataFmt = c.dataDesejada
        ? new Date(c.dataDesejada).toLocaleDateString("pt-BR")
        : null;

      div.innerHTML = \`
        <h3>\${c.titulo}</h3>
        \${c.descricao ? \`<p>\${c.descricao}</p>\` : ""}
        \${c.imagens && c.imagens.length ? \`<div class="imagens">\${c.imagens.map((img) =>
          \`<a href="/api/anexo/\${c.id}/\${img.id}?senha=\${encodeURIComponent(senhaAtual)}" target="_blank" rel="noopener">
            <img src="/api/anexo/\${c.id}/\${img.id}?senha=\${encodeURIComponent(senhaAtual)}" alt="\${img.nome || "anexo"}" />
          </a>\`
        ).join("")}</div>\` : ""}
        <div class="meta">
          \${c.etiquetas.map((e) => \`<span class="chip" data-cor="\${e.color}">\${e.name}</span>\`).join("")}
          \${dataFmt ? \`<span class="chip data">Precisa até \${dataFmt}</span>\` : ""}
        </div>
        <div class="acoes">
          <button class="btn-resolver" data-id="\${c.id}">Marcar como resolvido</button>
          <a href="\${c.url}" target="_blank" rel="noopener">Ver no Trello →</a>
        </div>
        <div class="feedback" style="display:none;"></div>
      \`;
      div.dataset.titulo = c.titulo;
      div.dataset.descricao = c.descricao || "";
      listaEl.appendChild(div);
    });

    document.querySelectorAll(".btn-resolver").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Movendo...";
        const cardEl = btn.closest(".chamado");
        try {
          const data = await chamarApi(\`/api/chamados/\${btn.dataset.id}/resolver\`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ titulo: cardEl.dataset.titulo, descricao: cardEl.dataset.descricao }),
          });
          const feedback = cardEl.querySelector(".feedback");
          feedback.style.display = "block";
          feedback.innerHTML = \`
            <p style="margin: 0 0 8px;">
              Movido pra aguardando aprovação\${data.solicitante ? \` — avise <strong>\${data.solicitante}</strong>\` : ""}
              com este link, pra confirmar que ficou certo:
            </p>
            <input readonly id="link-\${btn.dataset.id}" value="\${data.linkConfirmacao}"
              style="width:100%; background:var(--panel-2); border:1px solid var(--border); border-radius:6px; padding:8px 10px; color:var(--text); font-size:12.5px; margin-bottom:8px;" />
            <div style="display:flex; gap:8px;">
              <button type="button" class="btn-copiar" data-link="\${data.linkConfirmacao}" style="flex:1; background:var(--panel-2); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:8px; font-size:13px; cursor:pointer;">Copiar link</button>
              <button type="button" class="btn-concluir" style="flex:1; background:var(--accent); color:#0e1016; border:none; border-radius:6px; padding:8px; font-size:13px; font-weight:700; cursor:pointer;">Já mandei ✓</button>
            </div>
          \`;
          btn.remove();
          feedback.querySelector(".btn-copiar").addEventListener("click", (e) => {
            navigator.clipboard.writeText(e.target.dataset.link);
            e.target.textContent = "Copiado!";
            setTimeout(() => (e.target.textContent = "Copiar link"), 1500);
          });
          feedback.querySelector(".btn-concluir").addEventListener("click", () => {
            cardEl.remove();
            if (!document.querySelectorAll(".chamado").length) {
              document.getElementById("vazio").style.display = "block";
            }
          });
        } catch (err) {
          btn.disabled = false;
          btn.textContent = "Marcar como resolvido";
          alert("Erro: " + err.message);
        }
      });
    });
  }

  document.getElementById("senha").addEventListener("keydown", (e) => {
    if (e.key === "Enter") entrar();
  });

  // Se já tem senha guardada nessa aba, tenta entrar direto.
  if (senhaAtual) entrar();
</script>
</body>
</html>
`;

app.get("/painel", (req, res) => {
  res.type("html").send(PAGINA_PAINEL);
});

app.listen(PORT, "0.0.0.0", () => console.log(`Servidor rodando na porta ${PORT}`));
