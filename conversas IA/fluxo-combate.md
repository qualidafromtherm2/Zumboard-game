# Fluxo de Combate — Munchkin Digital

> Documento para continuidade em futuras conversas com IA.
> Descreve o fluxo completo da Fase 1 e Fase 2 do combate construído até 09/03/2026.

---

## Visão Geral

- Frontend: `index.html` (JS inline, sem bundler). Polling a cada 1 segundo via `setInterval`.
- Backend: Node/Express em `backend/server.js`, porta 3000.
- Comunicação entre abas/jogadores: **exclusivamente via SQL** (PostgreSQL, schema `mtkin`).
- Hospedagem alvo: Render (backend) + GitHub Pages ou Render Static (frontend).

---

## Tabelas envolvidas no combate

### `mtkin.combate`
Fonte de verdade do combate ativo.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id_combate` | VARCHAR(64) UNIQUE | ID único do combate |
| `id_sala` | INTEGER FK → rooms | Sala onde ocorre |
| `id_jogador` | INTEGER FK → users | Jogador que está lutando |
| `forca_jogador` | INTEGER | Força do lutador no momento do início |
| `forca_monstro` | INTEGER | Força do monstro |
| `id_carta_monstro` | INTEGER FK → cartas | Carta do monstro |
| `simulado` | BOOLEAN | Dados do simulador |
| `status` | VARCHAR(30) | `Fase 1` → `Fase 2` → `vitoria`/`derrota`/`fuga` |
| `botoes_jogador` | TEXT | Botões do lutador: `''` / `'Lutar'` / `'Correr;Pedir ajuda'` |
| `botoes_outros_jogadores` | TEXT | Botões convite: `'Entrar no combate;Não entrar'` ou `''` |
| `interferencia` | TEXT | IDs dos não-lutadores que já decidiram: `'2;5;7'` |
| `criado_em` | TIMESTAMPTZ | |
| `atualizado_em` | TIMESTAMPTZ | |

### `mtkin.combate_participacao`
Registra cada jogador que entrou no combate como ajudante.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id_sala` | INTEGER | |
| `id_combate` | VARCHAR(64) | |
| `id_jogador_luta` | INTEGER | Lutador principal |
| `id_jogador` | INTEGER | Participante (helper) |
| `status` | TEXT | `esperando` / `participando` / `pronto` / `recusou` |
| `duo_pronto_lutador` | BOOLEAN | Reservado para modo duo futuro |
| `duo_pronto_helper` | BOOLEAN | Reservado para modo duo futuro |

### `mtkin.sala_online`
Jogadores ativos na sala. Usado para contar quantos precisam decidir.

---

## Fluxo Completo — Fase 1

### Gatilho
Jogador cujo turno é o atual clica **Abrir Porta**.

### Backend: `POST /api/combate/iniciar-participacao`
1. Lê `estado_turno` para obter carta do monstro e força ativa.
2. Calcula `forca_jogador` e `forca_monstro`.
3. Determina convite:
   - `forca_jogador > forca_monstro` → `botoes_outros = 'Entrar no combate;Não entrar'`
   - Caso contrário → `botoes_outros = ''` (monstro mais forte, outros não são convidados)
4. INSERTs na `mtkin.combate` com `status = 'Fase 1'`, `botoes_jogador = ''`.

### Frontend: todos os jogadores poliam `GET /api/combate/estado` a cada 1s

**Cache no `sessionStorage` (`combate_cache`) — não-lutadores:**
```json
{
  "em_combate": true,
  "id_combate": "...",
  "sou_lutador": false,
  "botoes_outros": "Entrar no combate;Não entrar",
  "status_snapshot": "Fase 1",
  "minha_decisao": null,
  "botoes_renderizados": false
}
```

**Cache do lutador:**
```json
{
  "em_combate": true,
  "id_combate": "...",
  "sou_lutador": true,
  "status_snapshot": "Fase 1",
  "minha_decisao": null,
  "botoes_renderizados": false
}
```

### UI — Lutador (Fase 1)
- `messageCardOptions` oculto.
- Texto: `"Aguardando os outros jogadores decidirem..."`.

### UI — Não-lutadores (Fase 1)
Condição: `botoes_outros_jogadores = 'Entrar no combate;Não entrar'`

- Aparecem botões **Entrar no combate** e **Não entrar**.
- Clicar **Entrar no combate**:
  - `POST /api/combate/participar` → insere em `combate_participacao` com `status='participando'`
  - Cache: `minha_decisao = 'entrar'`
  - UI: só `✅ Pronto` visível + zona do monstro aberta.
  - Clicar **Pronto**: `POST /api/combate/pronto-participacao` → append do userId em `interferencia`.
    - Cache: `minha_decisao = 'pronto'`
- Clicar **Não entrar**:
  - `POST /api/combate/recusar` → append do userId em `interferencia` imediatamente.
  - Cache: `minha_decisao = 'nao-entrar'`
  - UI: tudo oculto, texto "Aguardando resultado..."

### Controle de `interferencia`
Cada não-lutador que decide (entrou+pronto OU recusou) tem seu `id_player` adicionado à coluna `interferencia` de `mtkin.combate` via SQL:
```sql
UPDATE mtkin.combate
SET interferencia = CASE
  WHEN interferencia = '' OR interferencia IS NULL THEN $1::text
  ELSE interferencia || ';' || $1::text
END
WHERE id_combate = $2
```

---

## Transição Fase 1 → Fase 2

### Quem detecta: backend `GET /api/combate/estado`

A cada poll (1s), quando `status = 'Fase 1'`:
1. Conta `totalOutros = COUNT(room_participants WHERE room_id = sala AND user_id != id_jogador_lutador AND is_online = true)`.
2. Conta `interferidos = interferencia.split(';').length`.
3. `todosDecidiram = totalOutros === 0 || interferidos >= totalOutros`.
4. Se `todosDecidiram`, executa **atomicamente**:
```sql
UPDATE mtkin.combate
SET status = 'Fase 2',
    botoes_jogador = <'Lutar' ou 'Correr;Pedir ajuda'>,
    botoes_outros_jogadores = '',
    interferencia = '',
    atualizado_em = NOW()
WHERE id_combate = $id AND status = 'Fase 1'
```
- `forca_jogador > forca_monstro` → `botoes_jogador = 'Lutar'`
- Caso contrário → `botoes_jogador = 'Correr;Pedir ajuda'`

---

## Fluxo Completo — Fase 2

### UI — Não-lutadores (Fase 2)
- `jaInterferiu = true` (seu ID estava em `interferencia` antes da limpeza).
- No entanto, após a limpeza do DB, o polling detecta `interferencia = ''`.
- Cache `minha_decisao` já é `'pronto'` ou `'nao-entrar'` ou `'interferido'`.
- `pollAjudaStatus`: guard `minha_decisao != null` → esconde todos os botões de oferta.
- Tela: totalmente limpa, "Aguardando resultado do combate...".

### UI — Lutador (Fase 2)
Cache atualiza `status_snapshot = 'Fase 2'` e **`stopCombateEstadoPolling()` é chamado** — polling cessa, UI fica estável sem piscar.
- `c.botoes = ['Lutar']` → mostra botão **Lutar** (`[data-action="fight"]`).
- `c.botoes = ['Correr', 'Pedir ajuda']` → mostra botões **Correr** e **Pedir ajuda**.
- Texto contextual:
  - Lutar: `"Você está mais forte! Clique Lutar para vencer o monstro."`
  - Correr/Ajuda: `"O monstro está mais forte... Corra ou peça ajuda!"`
- Na próxima vez que o polling rodar (antes de parar), se `cache.status_snapshot === 'Fase 2'` já estiver definido E o servidor confirma `status === 'Fase 2'`, reaplicar a UI (botões + texto) e então parar — garante restauração após recarga de página.

### Recarga de página durante Fase 2 (lutador)
Sequência ao recarregar:

1. `updateMessageCard()` executa antes do primeiro polling — `currentTurnState` ainda é `undefined`.
   - Guard: `getCombateCache()?.em_combate === true` → retorna sem mostrar "Abrir Porta".
2. `restoreEstadoTurno()` detecta `fase = 'monster'` → chama **`startCombateEstadoPolling()`** (antes faltava).
3. `pollCombateEstado()` recebe `cache.status_snapshot === 'Fase 2'` + servidor `status === 'Fase 2'` → reaplicar botões e parar.

---

## Guards de `combateAguardandoParticipacao`

A flag `window.combateAguardandoParticipacao = true` é definida na Fase 1 para bloquear o botão Lutar enquanto outros decidem. Ela **não é zerada automaticamente** ao recarregar. Por isso, todos os pontos que a testam precisam do guard de Fase 2:

| Local | Guard adicionado |
|---|---|
| Guard inicial em `updateTurnBanner` (battle-mode) | `&& !_fase2jaAtiva` |
| `updateBattleOptions()` | `&& !_fase2BA` |
| `updateCombatCounters()` (dentro do IIFE de combate) | `&& !_fase2CC` |
| `pollCombateEstado()` ao aplicar Fase 2 | `window.combateAguardandoParticipacao = false` |

Todos leem o cache: `getCombateCache()?.sou_lutador && getCombateCache()?.status_snapshot === 'Fase 2'`.

---

## Endpoints de Combate (todos em `/api/combate/`)

| Método | Rota | Quem chama | O que faz |
|---|---|---|---|
| POST | `/iniciar-participacao` | Lutador (ao abrir porta) | INSERT em `mtkin.combate` + Fase 1 |
| GET  | `/estado` | Todos (polling 1s) | Lê combate, detecta Fase 1→2, retorna botões |
| POST | `/participar` | Não-lutador (Entrar) | INSERT em `combate_participacao` status=participando |
| POST | `/recusar` | Não-lutador (Não entrar) | Append userId em `interferencia` |
| POST | `/pronto-participacao` | Não-lutador (Pronto) | Append userId em `interferencia` |

---

## Funções JS relevantes (index.html)

| Função | Linha aprox. | Descrição |
|---|---|---|
| `pollCombateEstado()` | ~7610 | Polling principal do combate (1s) |
| `startCombateEstadoPolling()` | ~7730 | Inicia o interval |
| `stopCombateEstadoPolling()` | ~7734 | Para o interval |
| `getCombateCache()` | ~7600 | Lê `sessionStorage.combate_cache` |
| `setCombateCache(obj)` | ~7603 | Escreve no sessionStorage |
| `clearCombateCache()` | ~7606 | Remove o cache |
| `updateBattleOptions()` | ~2139 | Mostra/esconde botão Lutar — usa guard Fase 2 |
| `updateCombatCounters()` | ~9932 | Recalcula forças e mostra botões — usa guard Fase 2 |
| `pollAjudaStatus()` | ~9350 | Polling de ofertas de ajuda (1s) — guard por `minha_decisao` |
| `updateTurnBanner()` | ~7100 | Polling de turno (1s) — controla zonas e botões por `effectiveStatus` |
| `updateMessageCard()` | ~2295 | Exibe card de mensagem (Abrir Porta etc.) — 4 guards antes de exibir |

---

## Variáveis globais relevantes

```javascript
let combateEstadoPollInterval = null;  // interval do pollCombateEstado
let combateInterferido = false;        // flag local: este jogador já decidiu
let localCombatDecision = null;        // 'entrar' | 'nao-entrar' | null
window._meuStatusParticipacao = null;  // espelhado de effectiveStatus para pollAjudaStatus
window._duoMode = false;               // modo duo (feature futura, não usar ainda)
```

---

## Regras de negócio importantes

1. **`duoModo` NÃO é ativado por helpers** — apenas `estado_turno.duo_modo` (feature futura).
2. **Ordem de guards em `pollAjudaStatus`**: se `cache.minha_decisao != null` → retorna sem mostrar botões de oferta.
3. **`interferencia` é limpa no DB** ao entrar em Fase 2 — o cache local (`minha_decisao`) é o que mantém o estado para o cliente.
4. **O `UPDATE` Fase 1→2 usa `WHERE status='Fase 1'`** para garantir idempotência (múltiplos clientes podem chamar simultaneously).
5. **Zonas de combate** (`combatMonsterZone` / `combatPlayerZone`): zona do monstro visível para helpers na Fase 1; zona do jogador só para o lutador principal.
6. **`updateMessageCard()` tem 4 guards** antes de exibir "Abrir Porta": `doorPhase !== 'idle'`, `battle-mode` no body, `currentTurnState?.combateAtivo`, e `getCombateCache()?.em_combate`. O último é essencial porque `currentTurnState` ainda está `undefined` no primeiro tick após recarga.
7. **`startCombateEstadoPolling()` deve ser chamado em `restoreEstadoTurno`** (bloco `fase === 'monster'`), não apenas em `startBattleWithMonster`. Sem isso, ao recarregar a página o lutador nunca recebe a UI da Fase 2.
8. **`window.combateAguardandoParticipacao`** não é zerada ao recarregar — qualquer verificação dessa flag deve ter guard `&& !_fase2Ativa` nos três pontos: `updateTurnBanner`, `updateBattleOptions`, `updateCombatCounters`.

---

## O que ainda falta construir (próximas fases)

- **Ação Lutar**: resolver o combate, calcular vitória/derrota, distribuir tesouros.
- **Ação Correr**: rolar dado, aplicar penalidade se falhar.
- **Pedir Ajuda**: lutador escolhe um jogador, negociam termos, helper confirma.
- **Fase 3+**: pós-combate, loot, level up.
- **Modo Duo** (`duoModo`): dois jogadores lutam juntos — campos `duo_modo`, `duo_helper_id`, `duo_pronto_lutador`, `duo_pronto_helper` já existem em `estado_turno` mas não estão ativos.
