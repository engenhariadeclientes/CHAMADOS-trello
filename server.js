const express = require("express");
const multer = require("multer");
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
// Senha do seu painel privado (/painel). Sem isso configurado, o painel fica bloqueado.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Notificação de WhatsApp a cada chamado novo (opcional — se não configurar,
// o sistema segue funcionando normal, só sem avisar por WhatsApp).
const BOTCONVERSA_API_KEY = process.env.BOTCONVERSA_API_KEY;
const MEU_WHATSAPP = process.env.MEU_WHATSAPP; // seu número com DDI, ex: 5548999999999
const BOTCONVERSA_BASE = "https://backend.botconversa.com.br/api/v1/webhook";

if (!TRELLO_API_KEY || !TRELLO_TOKEN || !TRELLO_BOARD_ID) {
  console.error("⚠️  Faltam variáveis de ambiente: TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID");
}

const auth = () => `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;

// Cache simples em memória do id da lista e das etiquetas do board.
// Evita bater na API do Trello a cada chamado aberto.
let cache = { idList: null, idListFinalizada: null, labels: null, carregadoEm: 0 };
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

  cache = {
    idList: lista.id,
    idListFinalizada: listaFinalizada ? listaFinalizada.id : null,
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

// Avisa por WhatsApp que um chamado novo foi aberto. Nunca derruba a criação
// do cartão se falhar — só loga o erro e segue.
async function notificarWhatsapp({ card, etiquetaNome, dataDesejada }) {
  if (!BOTCONVERSA_API_KEY || !MEU_WHATSAPP) {
    console.warn("⚠️  BOTCONVERSA_API_KEY ou MEU_WHATSAPP não configurados — notificação de WhatsApp pulada.");
    return;
  }
  try {
    const phone = MEU_WHATSAPP.startsWith("+") ? MEU_WHATSAPP : `+${MEU_WHATSAPP.replace(/\D/g, "")}`;

    const subRes = await fetch(`${BOTCONVERSA_BASE}/subscriber/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "API-KEY": BOTCONVERSA_API_KEY },
      body: JSON.stringify({ phone, first_name: "Chamados", last_name: "Sistema" }),
    });
    const sub = await subRes.json();
    if (!sub?.id) {
      console.error("Falha ao localizar/criar subscriber pra notificação:", JSON.stringify(sub));
      return;
    }

    const linhas = [
      "🎫 Novo chamado aberto",
      "",
      card.name,
    ];
    if (etiquetaNome) linhas.push(`Prioridade: ${etiquetaNome}`);
    if (dataDesejada) linhas.push(`Data desejada: ${new Date(dataDesejada).toLocaleDateString("pt-BR")}`);
    linhas.push("", card.shortUrl);

    const msgRes = await fetch(`${BOTCONVERSA_BASE}/subscriber/${sub.id}/send_message/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "API-KEY": BOTCONVERSA_API_KEY },
      body: JSON.stringify({ type: "text", value: linhas.join("\n") }),
    });

    if (!msgRes.ok) {
      console.error("Falha ao enviar WhatsApp:", msgRes.status, await msgRes.text());
    } else {
      console.log("📱 Notificação de WhatsApp enviada.");
    }
  } catch (err) {
    console.error("Erro ao notificar WhatsApp (não bloqueia o chamado):", err.message);
  }
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
      `https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/cards/open?${auth()}&fields=${camposCartao}`
    );
    if (!cardsRes.ok) throw new Error(`Falha ao buscar cartões: ${cardsRes.status}`);
    const cards = await cardsRes.json();

    const abertos = cards
      .filter((c) => c.idList !== cache.idListFinalizada)
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
app.post("/api/chamados/:id/resolver", requireAdmin, async (req, res) => {
  try {
    await garantirCache();

    if (!cache.idListFinalizada) {
      return res.status(500).json({
        error: `Lista "${LISTA_FINALIZADA}" não encontrada no board — configure TRELLO_LISTA_FINALIZADA ou crie a lista.`,
      });
    }

    const moveRes = await fetch(
      `https://api.trello.com/1/cards/${req.params.id}?${auth()}&idList=${cache.idListFinalizada}`,
      { method: "PUT" }
    );
    if (!moveRes.ok) {
      const errText = await moveRes.text();
      throw new Error(`Trello recusou mover o cartão: ${moveRes.status} ${errText}`);
    }

    console.log(`✅ Chamado ${req.params.id} marcado como resolvido.`);
    res.json({ success: true });
  } catch (err) {
    console.error("Erro ao resolver chamado:", err.message);
    res.status(500).json({ error: err.message });
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

    const { titulo, descricao, dataDesejada, etiquetaId } = req.body;

    if (!titulo || !titulo.trim()) {
      return res.status(400).json({ error: "Título é obrigatório." });
    }

    const agora = new Date();
    const abertoEm = agora.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

    const descCompleta =
      `Aberto em: ${abertoEm}\n\n` + (descricao && descricao.trim() ? descricao.trim() : "(sem detalhes adicionais)");

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

    const etiquetaNome = etiquetaId
      ? cache.labels.find((l) => l.id === etiquetaId)?.name
      : null;
    notificarWhatsapp({ card, etiquetaNome, dataDesejada }); // não bloqueia — roda em paralelo

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
        <div class="meta">
          \${c.etiquetas.map((e) => \`<span class="chip" data-cor="\${e.color}">\${e.name}</span>\`).join("")}
          \${dataFmt ? \`<span class="chip data">Precisa até \${dataFmt}</span>\` : ""}
        </div>
        <div class="acoes">
          <button class="btn-resolver" data-id="\${c.id}">Marcar como resolvido</button>
          <a href="\${c.url}" target="_blank" rel="noopener">Ver no Trello →</a>
        </div>
      \`;
      listaEl.appendChild(div);
    });

    document.querySelectorAll(".btn-resolver").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Resolvendo...";
        try {
          await chamarApi(\`/api/chamados/\${btn.dataset.id}/resolver\`, { method: "POST" });
          btn.closest(".chamado").remove();
          if (!document.querySelectorAll(".chamado").length) {
            document.getElementById("vazio").style.display = "block";
          }
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
