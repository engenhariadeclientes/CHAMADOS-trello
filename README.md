# Chamados → Trello

Formulário que abre um cartão direto na lista **TAREFAS PENDENTES** do board
"AUTOMAÇÕES E CHAMADOS". A pessoa escolhe uma prioridade (mapeada nas 3
etiquetas reais do board), escreve os detalhes, pode marcar a data que
precisa daquilo, e anexar imagens.

A data de abertura não precisa ser um campo manual — o próprio Trello já
grava a hora de criação (aparece no histórico do cartão, tipo "adicionou
este cartão... há 10 minutos"). O sistema também escreve "Aberto em: ..." na
primeira linha da descrição, pra aparecer no corpo do cartão sem precisar
abrir o histórico.

## 1. Pegar a chave e o token do Trello

1. Acesse **https://trello.com/power-ups/admin** (ou https://trello.com/app-key)
   logado com a conta que tem acesso ao board.
2. Copie a **API Key** mostrada na página.
3. Na mesma página, clique no link para gerar um **Token** (autoriza a chave
   a agir em nome da sua conta). Copie o token gerado.

Guarde os dois — vão virar variáveis de ambiente.

## 2. Variáveis de ambiente (Railway → Variables)

| Variável | Valor |
|---|---|
| `TRELLO_API_KEY` | a API Key do passo 1 |
| `TRELLO_TOKEN` | o Token do passo 1 |
| `TRELLO_BOARD_ID` | `XIQU86kd` (o pedaço da URL do board: `trello.com/b/XIQU86kd/...`) |
| `TRELLO_LISTA_DESTINO` | `TAREFAS PENDENTES` (opcional — já é o padrão) |
| `BOTCONVERSA_API_KEY` | a mesma chave que vocês já usam nos outros serviços (Duplique/DSC) |
| `MEU_WHATSAPP` | seu número com DDI, ex: `5548999999999` (opcional — sem isso, o sistema funciona igual, só sem avisar por WhatsApp) |
| `ADMIN_PASSWORD` | uma senha sua, à sua escolha — protege o `/painel` (sem isso configurado, o painel fica bloqueado pra todo mundo) |
| `TRELLO_LISTA_FINALIZADA` | `FINALIZADAS` (opcional — já é o padrão) |

## O painel (`/painel`)

Acesse `sua-url.up.railway.app/painel` — pede uma senha (a que você colocou em
`ADMIN_PASSWORD`) e mostra todos os chamados em aberto, com um botão
**"Marcar como resolvido"** em cada um.

Resolver um chamado **não apaga nada de verdade** — o cartão é movido pra
lista **FINALIZADAS** no Trello (a mesma que já existe no seu board). Ele
some da lista de pendências do painel, mas continua salvo lá, com todo o
histórico e os anexos.

## 3. Deploy

São só 3 arquivos, todos soltos na raiz do repo (sem nenhuma pasta):
`server.js`, `package.json`, `README.md`. Sobe os 3 no GitHub, conecta o
repo no Railway — ele detecta o `package.json`, roda `npm install` e
`npm start`. O Railway te dá uma URL tipo `chamados-xxxx.up.railway.app` —
é ela que você compartilha com quem vai abrir chamados.

## Como funciona por dentro

- `GET /etiquetas` — busca as etiquetas reais do board no Trello (nome, cor,
  id) pra desenhar os botões de prioridade sem IDs fixos no código. Assim,
  se um dia renomear ou mudar a cor de uma etiqueta no Trello, o formulário
  já reflete sozinho.
- `POST /criar-chamado` — cria o cartão na lista certa, com título,
  descrição, data desejada (`due`) e a etiqueta escolhida; depois sobe cada
  imagem anexada como anexo do cartão.
- O id da lista e as etiquetas ficam em cache por 10 minutos em memória,
  pra não bater na API do Trello a cada chamado.

## Limites

- Até 6 imagens por chamado, 8MB cada (dá pra ajustar em `src/server.js`,
  na constante `limits` do multer).
- Se a lista "TAREFAS PENDENTES" for renomeada no Trello, o servidor passa
  a dar erro até você atualizar `TRELLO_LISTA_DESTINO` ou renomear de volta.
