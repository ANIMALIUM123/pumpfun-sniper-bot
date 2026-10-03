# Pump.fun: Sniper, Copy Trade e carteira

Aplicação experimental TypeScript/Node para uso local ou auto-hospedado, com
dashboard em português, Express e SQLite. **Simulação (`DRY_RUN=true`) é o padrão.
Não é um produto pronto para produção. Nenhuma negociação mainnet foi realizada
para validar esta integração.**

## Integração com o PR #1

Esta implementação reutiliza o [PR #1](https://github.com/ANIMALIUM123/pumpfun-sniper-bot/pull/1),
commit `f930f512e453a0c89e50c4d4c3e1c9f639f10273`, que estava aberto e em rascunho
ao iniciar o trabalho. Os arquivos daquela implementação estão incluídos nesta
branch; não foi alterada a branch do PR #1 e nenhum PR foi mesclado. Há sobreposição
intencional: revise os PRs juntos antes de decidir a ordem de integração.

## Iniciar no VSCode

Requer Node **22.12+**, npm e um RPC Solana HTTP/WebSocket. No terminal do VSCode:

```bash
npm ci
cp .env.example .env
# Edite .env localmente, sem publicar segredos.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Use o valor gerado em API_KEY, apenas no seu .env.
npm run typecheck
npm test
npm run build
npm start
# Durante desenvolvimento: npm run dev
```

Abra **http://127.0.0.1:3000** e informe a chave local da API. A chave fica somente
na memória da página, não em `localStorage`. Sem `API_KEY`, os controles e a carteira
ficam indisponíveis. Reiniciar a aplicação não deve iniciar entradas automaticamente.

`RPC_URL`, `WS_URL` e `FALLBACK_RPC_URLS` configuram provedores externos, com failover.
Sem configuração usa-se o RPC público, sujeito a limites e indisponibilidade.
**O backend/indexador não é um RPC auto-hospedado.** O WebSocket observa transações
já executadas; não é um mempool público de transações pendentes.

## Abas e operação

- **Sniper:** novas criações Pump.fun, compra configurável, take-profit, stop-loss,
  trailing stop, timeout sem ganho e tempo máximo de posição.
- **Copy Trade:** um endereço público acompanhado; compras com orçamento fixo ou
  proporcional limitado e vendas proporcionais às posições daquele endereço.
- **Carteira:** criar carteira dedicada cifrada, desbloquear/bloquear e selecionar
  endereço somente leitura ou conectar uma carteira externa.
- **Configurações:** status de RPC/Jupiter e limites; chaves são configuradas no
  servidor, nunca retornadas ao navegador.

Abrir uma aba **não ativa** uma estratégia. Iniciar/parar é uma operação explícita,
validada pelo servidor. Apenas uma estratégia de entrada fica ativa por vez.
Trocas cancelam novas entradas; posições existentes continuam com gerenciamento
de risco, inclusive as de outra aba. Pausar entradas não significa vender.
Liquidação/venda manual exige confirmação separada.

Copy trade é **reativo**. Não há garantia de lucro, mesmo preço, saída imediata,
mesmo slot ou uma latência numérica. Logs do painel registram tempos observados;
etapas não executadas não recebem números fictícios.

## Copy Trade: segurança e suporte

A identificação precisa de uma transação bem-sucedida e de instruções, contas,
eventos e saldos coerentes. Transferências, transações falhas, operações ambíguas
e protocolos sem adaptador são ignorados com motivo registrado. Não se copia
qualquer aumento/diminuição de saldo como se fosse um swap.

Os valores brutos usam inteiros/bigints. Vendas usam a fração vendida pela origem
sobre os tokens rastreados do robô, não o número absoluto de tokens da origem;
não vendem saldos pessoais não rastreados. Orçamento proporcional sempre tem teto.
Há deduplicação persistida, fila limitada e backfill limitado: desconexões longas,
RPC lento ou fila cheia podem perder oportunidades. Não é uma ferramenta para
copiar todas as operações de qualquer DEX.

`processed` pode antecipar a observação mas inclui risco de fork. O padrão é
`confirmed`; os detalhes utilizados pelo copy trade são reconciliados em
`confirmed`. Esta escolha troca velocidade por maior segurança.

## Jupiter

Configure **`JUPITER_API_KEY` somente no `.env` local ou no secret do servidor**.
Nenhuma chave real foi fornecida ou incluída nos testes. Jupiter não substitui RPC.
Sua API pode exigir plano pago e impor limites.

O cliente usa o caminho oficial Swap V2 de cotação com `x-api-key`, valores brutos
inteiros, limite de slippage, timeout, validade da cotação e tratamento de 429/no-route.
Sem rota, a operação é recusada; não há fallback genérico inventado para
Raydium/Orca. Novos tokens Pump.fun frequentemente não têm rota Jupiter.

**A execução live de transações montadas por Jupiter é bloqueada** enquanto não
houver validação completa de payer/signers, gastos, destinatários, programas e
taxas. Uma cotação não é uma transação assinada nem uma execução garantida.
Não existe endpoint que assina transações arbitrárias enviadas pelo cliente.

O adaptador direto da curva Pump.fun é reutilizado para os caminhos suportados.
**Saída PumpSwap após migração não está implementada.** Um token migrado não passa
a ter saída segura só porque Jupiter retorna uma cotação. Não confunda simulação
com suporte live ou liquide por um protocolo não verificado.

## Carteiras e assinatura

### Carteira dedicada local

Criada com `Keypair.generate()` da biblioteca Solana, usando RNG criptográfico.
O arquivo configurado por `WALLET_VAULT_PATH` é cifrado com **AES-256-GCM** e chave
derivada por **scrypt** com salt aleatório. A senha não é gravada junto do ciphertext
nem registrada. Arquivos são privados e não entram no git ou imagem Docker.

Criar/selecionar carteira não inicia trades. Ela nasce bloqueada; desbloqueio tem
timeout (`WALLET_UNLOCK_TIMEOUT_MS`). Exportar o backup exige reautenticação e
confirmação. **O backup contém a chave privada:** guarde offline, não publique,
não faça capturas de tela e nunca use carteira principal com saldo elevado.
O bloqueio impede novas assinaturas locais; não revoga uma transação já assinada
ou enviada. Para manter saídas live possíveis, a capacidade de assinatura precisa
estar disponível. A UI informa o estado real, sem prometer saídas quando bloqueada.

### Carteira externa / somente leitura

Conectar uma carteira por uma interface Solana suportada **não concede assinatura
automática ao servidor**. Aprovação de transações pertence à carteira no navegador.
Uma seleção por endereço público é somente leitura, não prova controle do endereço
nem permite gastar seus fundos. Não há negociação externa autônoma nesta versão;
não se deve anunciar conexão como permissão para copy trade unattended.

### Live experimental

`DRY_RUN=false` exige **`LIVE_TRADING_ACK=EU_ENTENDO_O_RISCO`**, um início explícito
e capacidade de assinatura local configurada. O estado inicial continua inativo.
`WALLET_PRIVATE_KEY` existe apenas por compatibilidade com o PR #1; prefira a
carteira dedicada cifrada. Nunca envie seed/chave pelo chat ou em um commit.
Reconhecer risco não habilita protocolos que estejam bloqueados ou não suportados.

## Custos, riscos e implantação

Simulação não envia transações, mas consultas ao RPC/Jupiter contam nas cotas.
Live tem taxas Solana, prioridade, taxas de protocolo, aluguel de contas e slippage.
RPC gratuito não garante throughput, cobertura ou baixa latência. Dimensione filas,
posições e intervalos para seu plano e mantenha reserva de SOL para taxas.

Tokens podem sofrer rug pull, perder toda a liquidez, migrar ou ter extensões que
impedem venda. TP/SL são tentativas condicionadas a liquidez, dados e assinatura,
não garantias. Confirmação atrasada pode deixar uma operação pendente: não envie
uma compra/venda nova apenas porque uma requisição expirou.

API em loopback por padrão. Não exponha HTTP com senhas/chaves na internet.
Para acesso remoto, use HTTPS, autenticação, firewall e proxy restrito; origem,
Host e métodos são validados. `API_HOST` não local exige `API_KEY`.
Para um proxy HTTPS, declare o hostname em `API_ALLOWED_HOSTS` e a origem HTTPS
exata em `API_ALLOWED_ORIGINS`, sem curingas; não confie em headers encaminhados
de clientes arbitrários.
Proteja a máquina, dependências, permissões e backups. `.env`, `data/`, bancos,
carteiras e backups ficam fora do git e do contexto Docker.
Docker Compose publica a porta somente em `127.0.0.1`; configure `API_KEY` antes
de iniciar. Não monte sua carteira principal nem diretórios pessoais no container.

## Arquitetura e verificação

Base: `src/pumpfun`, `rpc`, `indexer`, `trading`, `database`, `api`, `config`, `alerts`.
As migrações SQLite são versionadas e acrescentadas, preservando a base do PR #1.
Configurações seguras são separadas de credenciais e do estado de entradas.
Posições e eventos são persistidos; o gerenciamento de posições não depende da aba.

```bash
npm run typecheck
npm test
npm run build
```

Testes usam RPC/Jupiter mockados e carteiras descartáveis locais, sem depósitos,
chaves reais ou envios mainnet. Passar nos testes **não comprova segurança em
produção**, cobertura de todos os programas ou resistência a todos os forks.
Leia também as limitações retornadas por `/api/operation` e pelo status Jupiter.

### API local

Com `API_KEY` configurada, envie a chave no header `x-api-key`.
Alterações exigem chave configurada e origem permitida; não há CORS
aberto. Corpos são JSON limitados e chamadas de controle têm limite por minuto.

| Método / rota | Uso |
|---|---|
| `GET /health` | Saúde pública, sem dados de carteira |
| `GET /api/status`, `/api/config` | Estado/configuração sem credenciais |
| `GET /api/operation`, `/api/operation/logs` | Estratégia autoritativa e eventos limitados |
| `POST /api/operation` | `{ "mode": "sniper", "confirmed": true }`; mode aceita idle/sniper/copytrade |
| `GET /api/copy/settings`, `PUT /api/copy/settings` | Configuração validada de copy trade |
| `GET /api/wallet/status` | Endereço, bloqueio e capacidade de assinatura |
| `POST /api/wallet/create`, `/api/wallet/unlock` | `{ "password": "<senha-local>" }` |
| `POST /api/wallet/lock` | Bloquear signer local |
| `POST /api/wallet/export` | Senha novamente + `confirmed: true`; backup privado |
| `GET /api/jupiter/status`, `POST /api/jupiter/quote` | Status e cotação, não assinatura |
| `GET /api/positions`, `/api/positions/open`, `/api/trades` | Posições compartilhadas e histórico |
| `POST /api/bot/pause`, `/api/bot/resume` | Pausa de entradas; não liquidação |
| `POST /api/positions/:mint/sell`, `/api/positions/liquidate` | Venda explícita com `confirmed: true` |
| `GET /api/tokens`, `/api/tokens/:mint`, `/api/prices/live`, `/api/metrics` | Leituras paginadas |

Cotação Jupiter recebe `inputMint`, `outputMint`, `amount` como string de unidades
brutas e `slippageBps` opcional. Nunca aceita chave privada ou transação arbitrária.
Erros de execução são bloqueados/registrados, não convertidos em sucesso por uma
mudança de saldo que pode pertencer a outra transação.

### Fontes oficiais consultadas

- [Pump.fun: documentação e IDLs](https://github.com/pump-fun/pump-public-docs)
  (`idl/pump.json`, instruções `buy_exact_quote_in_v2` / `sell_v2`).
- [Solana: logsSubscribe](https://solana.com/docs/rpc/websocket/logssubscribe) e
  [fonte oficial da documentação](https://github.com/solana-foundation/solana-com/tree/main/apps/docs/content/docs/en/rpc).
- [Jupiter: documentação oficial](https://developers.jup.ag/) e
  [fontes Swap V2](https://github.com/jup-ag/docs).

As páginas públicas de Jupiter/Solana não ficaram acessíveis neste ambiente;
foram consultadas fontes oficiais no GitHub. Protocolos evoluem: revise o IDL,
os endpoints e permissões antes de qualquer avaliação live.
