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

if (!TRELLO_API_KEY || !TRELLO_TOKEN || !TRELLO_BOARD_ID) {
  console.error("⚠️  Faltam variáveis de ambiente: TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID");
}

const auth = () => `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;

// Cache simples em memória do id da lista e das etiquetas do board.
// Evita bater na API do Trello a cada chamado aberto.
let cache = { idList: null, labels: null, carregadoEm: 0 };
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

  const lista = lists.find(
    (l) => l.name.trim().toLowerCase() === LISTA_DESTINO.trim().toLowerCase()
  );
  if (!lista) {
    throw new Error(
      `Lista "${LISTA_DESTINO}" não encontrada no board. Listas disponíveis: ${lists.map((l) => l.name).join(", ")}`
    );
  }

  cache = {
    idList: lista.id,
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

// Etiquetas para o formulário — devolve o que o front precisa pra desenhar
// as opções coloridas.
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
    border-radius: 10px;
    border: 2px solid transparent;
    padding: 14px 10px;
    cursor: pointer;
    text-align: center;
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.35;
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
      (data.labels || []).forEach((label, i) => {
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

app.listen(PORT, "0.0.0.0", () => console.log(`Servidor rodando na porta ${PORT}`));
