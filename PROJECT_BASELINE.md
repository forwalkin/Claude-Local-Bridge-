# Project Baseline — Claude Local Bridge

**Data de referência:** 18/11/2026  
**Branch analisada:** `main`  
**Commit analisado:** `d7db2eae27f90c8b0ad16fce07b65f8264d56e54`  
**Objetivo deste documento:** registrar o estado recuperado do repositório e estabelecer uma referência comum para a retomada do desenvolvimento.

> Este baseline foi produzido por inspeção estática do repositório no GitHub. Os testes foram contados nos arquivos, mas **não foram executados nesta inspeção**. Nenhuma funcionalidade descrita como pendente deve ser considerada implementada.

---

## 1. Definição do produto

O Claude Local Bridge é uma aplicação local para conectar o Claude.ai aos recursos autorizados do computador do usuário.

O produto terá duas interfaces com responsabilidades diferentes:

- **Claude.ai:** interface de conversa. O usuário conversa com Claude, descreve tarefas e recebe respostas.
- **Claude Local Bridge:** aplicação administrativa local, sem chat próprio. Permite configurar a integração, gerenciar Skills e permissões, aprovar operações quando necessário e consultar o histórico do que Claude acessou ou alterou.

O Bridge não deve ser tratado como um chatbot alternativo, nem como um executor irrestrito de comandos.

### Objetivos da aplicação administrativa

1. Exibir o estado do serviço local e da conexão com o conector.
2. Gerenciar Skills habilitadas e suas permissões.
3. Configurar os diretórios e recursos que podem ser acessados.
4. Apresentar operações que aguardam aprovação humana.
5. Consultar o histórico de atividades e resultados.
6. Mostrar arquivos e recursos lidos, criados, modificados ou removidos, conforme os eventos efetivamente observados.
7. Permitir pausar ou desconectar a integração local.

---

## 2. Estado do repositório

| Item | Estado observado |
|---|---|
| Repositório | `forwalkin/Claude-Local-Bridge-` |
| Visibilidade | Público |
| Licença | MIT |
| Branch padrão | `main` |
| Branches observadas | Apenas `main` |
| Último commit na data da inspeção | `d7db2eae27f90c8b0ad16fce07b65f8264d56e54` |
| Data do último commit | 30/08/2026 |
| Pull requests abertos observados | Nenhum |
| Issues abertas observadas | Nenhuma |

O repositório está preservado no GitHub. Não foi encontrada evidência de alterações posteriores ao commit acima durante esta inspeção.

---

## 3. Componentes já implementados

A árvore atual contém os seguintes módulos:

### 3.1 Registro e validação de Skills

Arquivos principais:

- `ai-skills/schemas/skill.schema.json`
- `ai-skills/manifests/workspace_cleaner.json`
- `backend-node/src/services/skillLoader.js`
- `backend-node/src/services/skillRegistry.js`
- `backend-node/src/services/skillValidator.js`

O manifesto define nome, descrição, tipo de operação destrutiva, schema de entrada, permissões e campos que representam caminhos. O loader carrega e valida manifestos. O registry mantém as Skills registradas imutáveis e implementa registro em lote com comportamento tudo-ou-nada.

### 3.2 PermissionEngine

Arquivos principais:

- `backend-node/src/security/permissionChecks.js`
- `backend-node/src/security/permissionEngine.js`

Valida a presença e o formato da entrada da chamada, e verifica se as permissões declaradas pela Skill são conhecidas e não estão vazias.

### 3.3 PathPolicy

Arquivos principais:

- `backend-node/src/security/pathPolicy.js`
- `backend-node/src/security/pathResolution.js`

Valida os campos declarados em `pathFields`, rejeita caminhos absolutos e padrões de traversal, resolve caminhos em relação ao sandbox e verifica canonicalização no filesystem para detectar escapes por symlink/junction. A implementação usa comparação de contenção baseada em caminhos relativos, em vez de uma comparação textual simples com `startsWith`.

**Limitação importante:** o comportamento real de junctions, reparse points e particularidades do NTFS ainda precisa ser validado em Windows real.

### 3.4 ConfirmationManager

Arquivos principais:

- `backend-node/src/security/confirmationManager.js`
- `backend-node/src/security/operationFingerprint.js`

Implementa solicitações de aprovação com identificador, fingerprint SHA-256 da operação, prazo de expiração, decisão de aprovar/recusar e consumo de uso único. O armazenamento atual é em memória e não sobrevive ao reinício do processo.

A aprovação precisa ser apresentada por uma futura camada de interface/sessão. A existência deste módulo, sozinha, não comprova que a decisão veio de uma pessoa: essa garantia deverá ser implementada na camada de transporte e na interface local.

### 3.5 ExecutionEngine

Arquivos principais:

- `backend-node/src/execution/executionEngine.js`
- `backend-node/src/execution/runnerPath.js`

Executa um runner como processo filho, sem shell, com diretório de trabalho definido, ambiente em allowlist, entrada JSON por stdin, timeout e limite de saída. Para operações marcadas como destrutivas, exige uma confirmação consumida com sucesso antes de iniciar o processo.

O último commit alterou a checagem para usar `operation.destructive`. O futuro orquestrador deve construir esse campo a partir do manifesto imutável registrado; nunca deve aceitar que o modelo ou a entrada do usuário escolha esse valor.

**Limitação importante:** o motor de execução não representa, por si só, uma integração geral e segura com CMD/PowerShell. A execução de terminal precisa de uma decisão arquitetural e de controles próprios antes de ser oferecida como ferramenta.

### 3.6 Auditoria

Arquivos principais:

- `backend-node/src/audit/auditLogger.js`
- `backend-node/src/audit/eventSeverity.js`
- `backend-node/src/audit/confirmationEventAdapter.js`
- `backend-node/src/audit/resultEventAdapters.js`

Padroniza eventos de auditoria, classifica severidade, permite adaptar resultados das camadas e aplica redação padrão a valores de entrada. O destino padrão atual é stdout em JSON Lines; armazenamento pesquisável, retenção e rotação ainda precisam ser definidos pela aplicação que integrar o logger.

---

## 4. Testes encontrados

Foram inspecionados os dez arquivos de teste abaixo. A contagem representa chamadas `test(...)` encontradas no conteúdo dos arquivos, não uma execução do test runner.

| Arquivo | Declarações de teste |
|---|---:|
| `auditLogger.test.js` | 26 |
| `confirmationManager.test.js` | 23 |
| `executionEngine.test.js` | 10 |
| `pathPolicy.test.js` | 22 |
| `pathResolution.test.js` | 21 |
| `permissionChecks.test.js` | 2 |
| `permissionEngine.test.js` | 13 |
| `skillLoader.test.js` | 3 |
| `skillRegistry.test.js` | 5 |
| `skillValidator.test.js` | 5 |
| **Total contado** | **130** |

O README também declara 130 testes. Entretanto, os subtotais exibidos na tabela de camadas do README somam 125, o que indica uma inconsistência documental de 5 testes que deverá ser corrigida após a execução da suíte.

Comando documentado para executar os testes:

```bash
cd backend-node
npm install
npm test
```

**Status de execução em 18/11/2026: não verificado.** Nenhum resultado de execução local ou CI foi obtido durante a recuperação.

---

## 5. Lacunas confirmadas na árvore atual

1. **Orquestrador ausente:** as camadas existem como módulos separados, mas ainda não há um fluxo único que receba uma chamada de ferramenta, valide, solicite aprovação quando necessária, execute e devolva um resultado.
2. **Servidor ausente:** `backend-node/package.json` declara `src/server.js` como entrada principal, mas esse arquivo não existe na árvore atual.
3. **Sandbox ausente:** `backend-node/src/config/paths.js` define um caminho `sandbox/` na raiz do projeto, mas a pasta não aparece na árvore versionada.
4. **Runners ausentes:** `runnerPath.js` espera a convenção `automation-python/skills/<skillName>/runner.py`, mas a árvore atual não contém a pasta `automation-python/`.
5. **Skill funcional ausente:** existe apenas o manifesto `workspace_cleaner.json`; não há runner real correspondente no repositório.
6. **Integração MCP ausente:** não há servidor MCP, endpoint remoto, autenticação ou mecanismo de pareamento com uma instância local.
7. **Interface administrativa ausente:** não há dashboard, painel de aprovações, tela de Skills ou histórico visual.
8. **Persistência ausente:** o estado do registry e das confirmações é mantido em memória. O armazenamento durável de auditoria também não está integrado.
9. **Correlação ponta a ponta ausente:** ainda não há identificador de correlação criado por solicitação e propagado por todas as camadas.
10. **Validação Windows pendente:** testes em Linux não substituem validação em Windows real, especialmente para paths, junctions, reparse points e encerramento de processos.

---

## 6. Arquitetura de destino proposta

A arquitetura recomendada separa o endpoint remoto usado pelo Claude.ai do serviço que realmente executa operações no computador.

```text
Claude.ai
   |
   | MCP remoto / HTTPS
   v
Gateway MCP remoto
   |
   | Canal persistente autenticado iniciado pelo agente local
   v
Claude Local Bridge (Windows)
   |
   +--> Orchestrator
   |       |
   |       +--> SkillRegistry / SkillLoader
   |       +--> PermissionEngine
   |       +--> PathPolicy
   |       +--> ConfirmationManager
   |       +--> ExecutionEngine
   |       +--> AuditLogger
   |
   +--> Interface administrativa local
           |
           +--> Estado e configuração
           +--> Skills e permissões
           +--> Aprovações pendentes
           +--> Histórico e detalhes das operações
```

### Regras arquiteturais

- Claude.ai é a interface de conversação; o Bridge não terá chat próprio.
- O endpoint MCP remoto não deve ter acesso direto ao CMD, PowerShell ou filesystem.
- O agente local inicia a conexão de saída com o gateway; não se deve exigir uma porta de entrada aberta no roteador do usuário.
- As solicitações recebidas do gateway são tratadas como não confiáveis e passam pelas validações locais.
- O gateway deve autenticar e associar cada solicitação à instalação local correta.
- Aprovações destrutivas devem ser feitas na interface administrativa local e vinculadas ao fingerprint exato da operação.
- A auditoria deve permitir relacionar solicitação, Skill, permissões, aprovação, execução e resultado.
- A ferramenta de terminal, se implementada, não poderá aceitar texto livre do modelo como comando irrestrito. Será necessário um contrato próprio com executáveis/argumentos permitidos, diretório de trabalho, ambiente, timeout, limite de saída e política de aprovação.
- A interface administrativa não deve depender da disponibilidade do Claude.ai para permitir ao usuário interromper o serviço ou revisar o histórico local.

### Nota de compatibilidade com Claude.ai

Na documentação oficial consultada em 18/11/2026:

- Conectores personalizados por MCP remoto são documentados para Claude nos planos Pro, Max, Team e Enterprise.
- A documentação não lista o plano Free entre os planos com suporte a conectores personalizados remotos.
- Claude aceita servidores remotos com SSE e Streamable HTTP; a documentação recomenda acompanhar a evolução do suporte a transportes.
- A autenticação OAuth é suportada, assim como servidores sem autenticação, embora este projeto deva exigir autenticação.

Referências oficiais:

- [Getting Started with Custom Connectors Using Remote MCP](https://support.anthropic.com/en/articles/11175166-about-custom-integrations-using-remote-mcp)
- [Building Custom Connectors via Remote MCP Servers](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers)
- [When to Use Desktop and Web Connectors](https://support.anthropic.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)

**Decisão ainda pendente:** selecionar a implementação do gateway/relay, fluxo OAuth ou pareamento e estratégia de hospedagem. A topologia acima é a direção proposta, não uma implementação já validada. Antes de adotar um fornecedor, será feito um protótipo de conectividade e autenticação.

---

## 7. Plano de retomada

### Fase 0 — Recuperação e baseline
- [x] Inspecionar a branch principal e o histórico.
- [x] Inspecionar a árvore de arquivos e os componentes existentes.
- [x] Contar as declarações de teste.
- [x] Registrar lacunas conhecidas e arquitetura proposta.
- [ ] Executar a suíte completa em ambiente local.
- [ ] Corrigir divergências entre README, árvore e comportamento real.

### Fase 1 — Orchestrator Core
- Definir o contrato de entrada e saída de uma chamada de ferramenta.
- Construir a operação internamente a partir da Skill registrada e de sua metadata confiável.
- Orquestrar validação de schema/permissões, política de caminhos, aprovação, execução e auditoria.
- Gerar e propagar um correlation ID.
- Garantir que falhas e recusas não sejam confundidas com execução bem-sucedida.
- Cobrir o fluxo com testes de integração usando dependências injetadas.

### Fase 2 — Primeira Skill segura
- Implementar primeiro uma Skill de inspeção somente leitura.
- Criar runner e diretório de sandbox de forma explícita.
- Validar argumentos, caminhos e limites.
- Não usar a Skill destrutiva existente como primeiro teste de execução real.

### Fase 3 — Prova de conceito MCP
- Implementar um servidor MCP remoto compatível com Claude.ai.
- Provar autenticação, pareamento e associação com uma instalação local.
- Implementar o canal autenticado iniciado pelo Bridge local.
- Verificar desconexão, reconexão, expiração, replay e isolamento entre instalações.
- Confirmar a disponibilidade do recurso no plano Claude utilizado.

### Fase 4 — Aplicação administrativa
- Dashboard de estado.
- Gerenciamento de Skills e permissões.
- Aprovações pendentes.
- Histórico de auditoria e detalhes das operações.
- Configuração e encerramento seguro do serviço local.

### Fase 5 — Capacidades Windows
- Validar o PathPolicy em Windows real.
- Implementar ferramentas de filesystem e processos com escopo controlado.
- Projetar separadamente qualquer capacidade de CMD/PowerShell.
- Testar limites, cancelamento, encerramento de processos e recuperação.

### Fase 6 — Endurecimento e distribuição
- Revisão de segurança e threat model.
- Testes de instalação, atualização, desinstalação e recuperação.
- Gestão segura de segredos e logs.
- Documentação de usuário e desenvolvedor.
- Definição do pacote de distribuição.

---

## 8. Critério de conclusão do primeiro marco funcional

O primeiro marco não será considerado concluído apenas porque o Claude consegue chamar um endpoint.

Será necessário demonstrar, por teste automatizado e prova prática, que:

1. Uma chamada MCP chega ao gateway autenticado.
2. A chamada alcança somente a instalação local pareada.
3. O Orchestrator local resolve uma Skill registrada.
4. Entradas inválidas ou permissões insuficientes são recusadas.
5. Uma operação destrutiva fica bloqueada até aprovação local.
6. A aprovação não pode ser reaproveitada para outra operação.
7. O ExecutionEngine executa somente o runner esperado, sob os limites definidos.
8. O resultado e os eventos de auditoria retornam ao Claude.
9. A interface administrativa mostra a atividade correspondente.
10. Desconectar o gateway ou parar o serviço local não deixa uma execução sem controle.

---

## 9. Regra de trabalho e preservação

- Cada tarefa de implementação deverá ter escopo, arquivos permitidos, contratos, critérios de aceitação e testes.
- Alterações devem ser realizadas em branch própria e revisadas antes de integrar em `main`.
- Cada etapa concluída deve gerar commit no GitHub, mesmo que o projeto ainda tenha pendências não relacionadas.
- Não declarar testes aprovados sem executar e registrar o resultado.
- Não considerar documentação, mocks ou testes isolados como prova de integração ponta a ponta.
- Decisões que alterem escopo, modelo de confiança, acesso ao filesystem, execução de terminal ou arquitetura de rede devem ser registradas antes da implementação.

**Este documento é o baseline de recuperação. Ele descreve o estado observado em 18/11/2026 e deverá ser atualizado conforme o repositório e as decisões técnicas evoluírem.**
