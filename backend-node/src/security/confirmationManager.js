const crypto = require("node:crypto");

const { computeOperationFingerprint } = require("./operationFingerprint");

/**
 * ConfirmationManager
 *
 * Responde apenas: "esta operação específica precisa de aprovação humana,
 * e essa aprovação chegou de forma que corresponde exatamente ao que foi
 * mostrado, dentro do prazo, uma única vez?"
 *
 * NÃO conhece PermissionEngine, PathPolicy ou ExecutionEngine. NÃO executa
 * comandos, NÃO acessa CMD/Python/filesystem. NÃO decide sozinho se uma
 * skill é destructive — apenas recebe a operação já validada (incluindo o
 * campo `destructive`, vindo do manifesto) e a apresenta para aprovação.
 * NÃO existe nenhum caminho de auto-aprovação: approve/deny só acontecem
 * via resolveConfirmation(), chamado pela camada de transporte em resposta
 * a uma interação humana real — essa garantia de que "veio de um humano de
 * verdade" é responsabilidade da futura camada de sessão/WebSocket, não
 * deste módulo.
 *
 * Armazenamento em memória (Map) — não sobrevive a reinício do processo.
 * Isso é uma decisão explícita para o MVP; persistência é pendência
 * arquitetural registrada para uma etapa futura, não resolvida aqui.
 *
 * Máquina de estados:
 *
 *   PENDING --resolve(approve)--> APPROVED --consume()--> CONSUMED
 *   PENDING --resolve(deny)---> DENIED
 *   PENDING --TTL excedido----> EXPIRED
 *
 * APPROVED, DENIED, EXPIRED e CONSUMED são terminais. Nenhuma transição
 * parte deles. Qualquer resolve()/consume() sobre um estado terminal
 * retorna um resultado estruturado descrevendo o motivo, sem mutar nada.
 */
function createConfirmationManager({
  clock = { now: () => Date.now() },
  scheduler = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) },
  defaultTtlMs = 120000,
  onEvent = () => {}
} = {}) {
  const store = new Map();

  function emit(eventName, payload) {
    onEvent(eventName, { ...payload, timestamp: new Date(clock.now()).toISOString() });
  }

  function buildSummary(operation, expiresAt) {
    return {
      skillName: operation.skillName,
      skillDescription: operation.description ?? null,
      destructive: operation.destructive,
      permissionsUsed: operation.permissions,
      resolvedPaths: operation.resolvedPaths,
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  function handleTimerExpiry(confirmationId) {
    const record = store.get(confirmationId);

    // Registro pode já ter sido removido por limpeza, ou resolvido antes do
    // timer disparar — nesse caso não há nada a fazer, não é um erro.
    if (!record || record.state !== "PENDING") {
      return;
    }

    record.state = "EXPIRED";
    record.resolvedAt = clock.now();

    emit("confirmation.expired", {
      confirmationId,
      skillName: record.operation.skillName,
      sessionId: record.sessionId
    });
  }

  /**
   * Cria uma nova confirmação pendente para uma operação já validada.
   *
   * `operation` deve ser o objeto resultante do merge imutável de
   * PermissionEngine + PathPolicy: { skillName, description, destructive,
   * permissions, resolvedPaths, input }. Não é responsabilidade deste
   * método validar essa forma em profundidade — isso já deveria ter
   * acontecido nas camadas anteriores.
   */
  function requestConfirmation({ operation, sessionId, ttlMs = defaultTtlMs }) {
    if (!operation || typeof operation !== "object") {
      throw new TypeError("requestConfirmation requer uma operation válida (erro de programação, não de negócio).");
    }

    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("requestConfirmation requer um sessionId (string não-vazia).");
    }

    if (typeof ttlMs !== "number" || ttlMs <= 0) {
      throw new TypeError("ttlMs deve ser um número positivo.");
    }

    const confirmationId = crypto.randomUUID();
    const fingerprint = computeOperationFingerprint(operation);
    const now = clock.now();
    const expiresAt = now + ttlMs;

    const timerHandle = scheduler.setTimeout(() => handleTimerExpiry(confirmationId), ttlMs);

    const record = {
      confirmationId,
      sessionId,
      operation,
      fingerprint,
      state: "PENDING",
      createdAt: now,
      expiresAt,
      resolvedAt: null,
      resolvedBy: null,
      timerHandle
    };

    store.set(confirmationId, record);

    emit("confirmation.requested", {
      confirmationId,
      skillName: operation.skillName,
      sessionId,
      destructive: operation.destructive
    });

    return {
      confirmationId,
      fingerprint,
      expiresAt: new Date(expiresAt).toISOString(),
      summary: buildSummary(operation, expiresAt)
    };
  }

  /**
   * Checagem de expiração "lazy": se o registro está PENDING mas o TTL já
   * passou, transiciona para EXPIRED aqui mesmo, antes de processar
   * qualquer decisão. Complementa (não substitui) o timer ativo — cobre o
   * caso em que resolve()/consume() é chamado entre o TTL expirar e o
   * timer disparar de fato (garante correção mesmo sob scheduler injetado
   * nos testes, onde o timer pode nunca ser "disparado" de verdade).
   */
  function expireIfPastTtl(record) {
    if (record.state === "PENDING" && clock.now() > record.expiresAt) {
      record.state = "EXPIRED";
      record.resolvedAt = clock.now();

      emit("confirmation.expired", {
        confirmationId: record.confirmationId,
        skillName: record.operation.skillName,
        sessionId: record.sessionId
      });
    }
  }

  /**
   * Aplica a decisão humana (approve/deny) sobre uma confirmação pendente.
   *
   * Totalmente síncrona — nenhum `await` entre a leitura do estado e sua
   * mutação — o que garante atomicidade sob o modelo de execução
   * single-threaded do Node: duas chamadas "concorrentes" (via Promise.all,
   * por exemplo) na prática executam uma inteiramente antes da outra
   * começar, então só a primeira consegue transicionar o estado; a segunda
   * sempre encontra o registro já não-PENDING.
   */
  function resolveConfirmation({ confirmationId, decision, fingerprint, sessionId }) {
    if (decision !== "approve" && decision !== "deny") {
      throw new TypeError('decision deve ser "approve" ou "deny" (erro de programação — vem do protocolo interno, não de texto livre externo).');
    }

    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("resolveConfirmation requer um sessionId (string não-vazia).");
    }

    if (typeof confirmationId !== "string") {
      // Um confirmationId malformado é plausível vindo de um cliente com
      // bug ou de tentativa de adulteração — tratado como negação de
      // negócio (not_found), nunca como exceção.
      emit("confirmation.not_found", { confirmationId, sessionId });
      return { outcome: "not_found", confirmationId, resolvedAt: null };
    }

    const record = store.get(confirmationId);

    if (!record) {
      emit("confirmation.not_found", { confirmationId, sessionId });
      return { outcome: "not_found", confirmationId, resolvedAt: null };
    }

    expireIfPastTtl(record);

    if (record.state !== "PENDING") {
      emit("confirmation.already_resolved_attempt", {
        confirmationId,
        sessionId,
        attemptedDecision: decision,
        actualState: record.state
      });

      return {
        outcome: record.state === "EXPIRED" ? "expired" : "already_resolved",
        confirmationId,
        resolvedAt: record.resolvedAt
      };
    }

    if (sessionId !== record.sessionId) {
      emit("confirmation.session_mismatch", {
        confirmationId,
        skillName: record.operation.skillName,
        attemptedSessionId: sessionId
      });

      return { outcome: "session_mismatch", confirmationId, resolvedAt: null };
    }

    if (fingerprint !== record.fingerprint) {
      emit("confirmation.fingerprint_mismatch", {
        confirmationId,
        sessionId,
        skillName: record.operation.skillName,
        at: "resolve"
      });

      return { outcome: "fingerprint_mismatch", confirmationId, resolvedAt: null };
    }

    // Ponto de transição real — tudo acima é validação sem mutação.
    record.state = decision === "approve" ? "APPROVED" : "DENIED";
    record.resolvedAt = clock.now();
    record.resolvedBy = sessionId;

    scheduler.clearTimeout(record.timerHandle);

    emit(record.state === "APPROVED" ? "confirmation.approved" : "confirmation.denied", {
      confirmationId,
      sessionId,
      skillName: record.operation.skillName
    });

    return {
      outcome: record.state === "APPROVED" ? "approved" : "denied",
      confirmationId,
      resolvedAt: record.resolvedAt
    };
  }

  /**
   * Consome uma confirmação já aprovada, autorizando o ExecutionEngine a
   * prosseguir. Uso único: a segunda tentativa de consumir a mesma
   * confirmação sempre falha. Recomputa a comparação de fingerprint contra
   * o valor armazenado — nunca contra dado externo reenviado.
   *
   * Chamado exclusivamente pelo ExecutionEngine (peça ainda não
   * implementada), nunca diretamente pelo frontend.
   */
  function consumeConfirmation({ confirmationId, fingerprint }) {
    if (typeof confirmationId !== "string") {
      emit("confirmation.not_found", { confirmationId });
      return { consumed: false, reason: "NOT_FOUND" };
    }

    const record = store.get(confirmationId);

    if (!record) {
      emit("confirmation.not_found", { confirmationId });
      return { consumed: false, reason: "NOT_FOUND" };
    }

    if (record.state !== "APPROVED") {
      if (record.state === "CONSUMED") {
        emit("confirmation.already_resolved_attempt", {
          confirmationId,
          attemptedAction: "consume",
          actualState: record.state
        });
        return { consumed: false, reason: "ALREADY_CONSUMED" };
      }

      emit("confirmation.consume_without_approval", {
        confirmationId,
        actualState: record.state
      });
      return { consumed: false, reason: "NOT_APPROVED" };
    }

    if (fingerprint !== record.fingerprint) {
      emit("confirmation.fingerprint_mismatch", {
        confirmationId,
        skillName: record.operation.skillName,
        at: "consume"
      });
      return { consumed: false, reason: "FINGERPRINT_MISMATCH" };
    }

    // Ponto de transição real.
    record.state = "CONSUMED";
    record.consumedAt = clock.now();

    emit("confirmation.consumed", {
      confirmationId,
      skillName: record.operation.skillName,
      sessionId: record.sessionId
    });

    return { consumed: true, reason: null };
  }

  /**
   * Remove do armazenamento em memória registros em estado terminal
   * (DENIED, EXPIRED, CONSUMED) resolvidos há mais de `olderThanMs`.
   *
   * NUNCA remove PENDING (ainda pode ser resolvido) nem APPROVED (ainda
   * pode ser consumido) — apenas os três estados verdadeiramente mortos.
   * Isso é um mecanismo mínimo de higiene de memória para o MVP; uma
   * varredura periódica automática (setInterval) fica como decisão de
   * wiring da camada que instanciar o ConfirmationManager em produção,
   * não deste módulo.
   */
  function purgeResolved({ olderThanMs = 0 } = {}) {
    const now = clock.now();
    let purged = 0;

    for (const [id, record] of store) {
      const isTerminalAndDead =
        record.state === "DENIED" || record.state === "EXPIRED" || record.state === "CONSUMED";

      if (!isTerminalAndDead) {
        continue;
      }

      const resolvedAt = record.consumedAt ?? record.resolvedAt ?? record.createdAt;

      if (now - resolvedAt >= olderThanMs) {
        scheduler.clearTimeout(record.timerHandle);
        store.delete(id);
        purged += 1;
      }
    }

    return purged;
  }

  function size() {
    return store.size;
  }

  return {
    requestConfirmation,
    resolveConfirmation,
    consumeConfirmation,
    purgeResolved,
    size
  };
}

module.exports = { createConfirmationManager };
