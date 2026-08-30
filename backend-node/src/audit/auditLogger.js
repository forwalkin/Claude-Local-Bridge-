const { getSeverity } = require("./eventSeverity");

/**
 * Política default de redação de dados sensíveis (item 7 da especificação):
 *  - `detail.input`, se presente, é reduzido a { keys: [...] } -- os NOMES
 *    dos campos do input da chamada são registrados, nunca os VALORES. O
 *    AuditLogger não tem como saber, de forma genérica, se um campo de uma
 *    skill futura contém algo sensível (ex: um campo "password").
 *  - `detail.resolvedPaths` é preservado integralmente, sem máscara --
 *    decisão explícita (item 8): o path canonicalizado é o dado de maior
 *    valor investigativo, e é interno ao sandbox controlado pelo próprio
 *    sistema, não dado arbitrário do usuário.
 *  - Qualquer outro campo em `detail` passa direto.
 *
 * Substituível via `redactor` injetável em createAuditLogger, sem precisar
 * alterar este módulo.
 */
function defaultRedactor(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return detail;
  }

  const redacted = { ...detail };

  if (redacted.input && typeof redacted.input === "object" && !Array.isArray(redacted.input)) {
    redacted.input = { keys: Object.keys(redacted.input) };
  }

  return redacted;
}

const defaultSink = {
  write(line) {
    process.stdout.write(line + "\n");
  }
};

/**
 * Converte um evento bruto (vindo de um adaptador de camada, ou já no
 * formato padrão) para o formato final gravado no log. Lança TypeError para
 * entradas estruturalmente inválidas -- mas essa exceção NUNCA escapa de
 * log(), que sempre a captura (ver comentário em createAuditLogger).
 *
 * timestamp: se o evento de origem já trouxer um `timestamp` (caso do
 * ConfirmationManager, que já registra seu próprio horário via seu próprio
 * clock antes de chamar onEvent), esse valor é preservado -- reflete melhor
 * o momento em que o evento realmente ocorreu, não o momento em que o
 * AuditLogger conseguiu processá-lo. Só gera um novo timestamp via `clock`
 * quando a origem não fornece um.
 */
function standardizeEvent(rawEvent, { clock, redactor }) {
  if (!rawEvent || typeof rawEvent !== "object") {
    throw new TypeError("AuditLogger.log requer um objeto de evento.");
  }

  if (typeof rawEvent.eventName !== "string" || rawEvent.eventName.length === 0) {
    throw new TypeError("Evento de auditoria requer eventName (string não-vazia).");
  }

  return {
    eventName: rawEvent.eventName,
    severity: rawEvent.severity || getSeverity(rawEvent.eventName),
    layer: rawEvent.layer ?? null,
    timestamp: rawEvent.timestamp ?? new Date(clock.now()).toISOString(),
    // Pendência arquitetural explícita (MVP): não existe hoje nenhuma peça
    // no sistema que gere um ID de correlação de ponta a ponta atravessando
    // PermissionEngine -> PathPolicy -> ConfirmationManager. Isso é
    // responsabilidade do futuro orquestrador, que precisaria gerar um ID
    // por tool_use e propagá-lo como parâmetro adicional por todas as
    // camadas -- mudança de assinatura ainda não feita. correlationId: null
    // é o estado honesto do MVP, não uma correlação parcial disfarçada.
    correlationId: rawEvent.correlationId ?? null,
    outcome: rawEvent.outcome ?? null,
    skillName: rawEvent.skillName ?? null,
    sessionId: rawEvent.sessionId ?? null,
    detail: redactor(rawEvent.detail ?? {})
  };
}

/**
 * createAuditLogger({ sink, clock, redactor }) -> { log, flush }
 *
 * NÃO importa nada de src/security/ ou src/services/ -- só conhece o
 * formato de evento padronizado (ver standardizeEvent). O acoplamento com
 * as camadas que emitem eventos vive nos adaptadores
 * (confirmationEventAdapter.js, resultEventAdapters.js), nunca aqui.
 *
 * Armazenamento default: stdout em JSON Lines (um objeto JSON por linha).
 * Rotação/agregação/retenção são responsabilidade de quem roda o processo
 * (redirecionamento de shell, serviço supervisor, etc.), não deste módulo
 * -- decisão registrada na especificação (item 10/11).
 *
 * Garantia central (item 14): log() NUNCA lança, para nenhum tipo de
 * entrada -- nem para eventos malformados, nem para falha do sink. Isso é
 * uma divergência deliberada do padrão adotado em PermissionEngine/
 * PathPolicy/ConfirmationManager (que lançam para erros de programação):
 * o AuditLogger existe num ponto do sistema onde uma falha de LOGGING
 * jamais pode derrubar uma decisão de segurança ou uma execução em
 * andamento. O trade-off aceito conscientemente: se o sink estiver
 * completamente quebrado, eventos podem ser perdidos silenciosamente (com
 * um best-effort de registrar isso em stderr) -- preferível a travar o
 * sistema por causa de uma falha de log.
 */
function createAuditLogger({
  sink = defaultSink,
  clock = { now: () => Date.now() },
  redactor = defaultRedactor
} = {}) {
  function log(rawEvent) {
    try {
      const standardized = standardizeEvent(rawEvent, { clock, redactor });
      const line = JSON.stringify(standardized);
      sink.write(line);
    } catch (err) {
      // Último recurso, best-effort: nunca deixa a falha do próprio
      // AuditLogger se propagar para quem chamou log().
      try {
        const message = err && err.message ? err.message : String(err);
        process.stderr.write(`[AuditLogger] falha ao registrar evento: ${message}\n`);
      } catch (_) {
        // Não há mais nada a fazer -- garantidamente não relança.
      }
    }
  }

  async function flush() {
    try {
      if (sink && typeof sink.flush === "function") {
        await sink.flush();
      }
    } catch (err) {
      try {
        const message = err && err.message ? err.message : String(err);
        process.stderr.write(`[AuditLogger] falha ao dar flush: ${message}\n`);
      } catch (_) {
        // Idem -- best-effort, nunca relança.
      }
    }
  }

  // Nenhum estado interno acumula eventos (sem array/Map de histórico) --
  // log() escreve e não guarda. Isso é o que evita a necessidade de
  // rotação/limpeza dentro deste módulo (item 11).
  return { log, flush };
}

module.exports = { createAuditLogger, defaultRedactor, defaultSink };
