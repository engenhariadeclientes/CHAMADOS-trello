const express = require("express");
const multer = require("multer");
const path = require("path");

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

app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, "0.0.0.0", () => console.log(`Servidor rodando na porta ${PORT}`));
