const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuditLogger, defaultRedactor } = require("../src/audit/auditLogger");
const { getSeverity, EVENT_SEVERITY, DEFAULT_SEVERITY } = require("../src/audit/eventSeverity");
const { adaptConfirmationEvent } = require("../src/audit/confirmationEventAdapter");
const { adaptPermissionResult, adaptPathResult } = require("../src/audit/resultEventAdapters");
const { createConfirmationManager } = require("../src/security/confirmationManager");

function makeFakeSink() {
  const lines = [];
  return {
    lines,
    write(line) {
      lines.push(line);
    },
    parsed() {
      return lines.map((l) => JSON.parse(l));
    }
  };
}

function makeFakeClock(startAt = 2_000_000) {
  let current = startAt;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    }
  };
}

// ---------------------------------------------------------------------
// 1. Evento mínimo válido -> sink recebe linha JSON com campos obrigatórios
// ---------------------------------------------------------------------
test("1. log() com evento mínimo válido escreve JSON com todos os campos obrigatórios", () => {
  const sink = makeFakeSink();
  const clock = makeFakeClock();
  const logger = createAuditLogger({ sink, clock });

  logger.log({ eventName: "permission.allowed", layer: "PermissionEngine", outcome: "ALLOWED" });

  assert.equal(sink.lines.length, 1);
  const record = sink.parsed()[0];

  assert.equal(record.eventName, "permission.allowed");
  assert.equal(record.severity, "info");
  assert.equal(record.layer, "PermissionEngine");
  assert.equal(typeof record.timestamp, "string");
  assert.equal(record.outcome, "ALLOWED");
  assert.ok("correlationId" in record);
  assert.ok("skillName" in record);
  assert.ok("sessionId" in record);
  assert.ok("detail" in record);
});

// ---------------------------------------------------------------------
// 2. correlationId ausente -> null, sem lançar
// ---------------------------------------------------------------------
test("2. log() preenche correlationId: null quando não fornecido, sem lançar", () => {
  const sink = makeFakeSink();
  const logger = createAuditLogger({ sink, clock: makeFakeClock() });

  assert.doesNotThrow(() => logger.log({ eventName: "path.allowed" }));

  const record = sink.parsed()[0];
  assert.equal(record.correlationId, null);
});

// ---------------------------------------------------------------------
// 3. log() nunca lança, mesmo se o sink lançar
// ---------------------------------------------------------------------
test("3. log() nunca lança mesmo se o sink lançar uma exceção", () => {
  const brokenSink = {
    write() {
      throw new Error("disco cheio, simulado");
    }
  };
  const logger = createAuditLogger({ sink: brokenSink, clock: makeFakeClock() });

  assert.doesNotThrow(() => logger.log({ eventName: "confirmation.approved" }));
});

test("3b. log() nunca lança mesmo com evento completamente malformado", () => {
  const sink = makeFakeSink();
  const logger = createAuditLogger({ sink, clock: makeFakeClock() });

  assert.doesNotThrow(() => logger.log(null));
  assert.doesNotThrow(() => logger.log(undefined));
  assert.doesNotThrow(() => logger.log({}));
  assert.doesNotThrow(() => logger.log({ eventName: 123 }));
  assert.doesNotThrow(() => logger.log("string qualquer"));

  // Nenhum desses deveria ter produzido uma linha válida no sink.
  assert.equal(sink.lines.length, 0);
});

// ---------------------------------------------------------------------
// 4. Redação default: detail.input vira só as chaves, nunca os valores
// ---------------------------------------------------------------------
test("4. redação default: detail.input é reduzido a nomes de campos, nunca valores", () => {
  const sink = makeFakeSink();
  const logger = createAuditLogger({ sink, clock: makeFakeClock() });

  logger.log({
    eventName: "permission.denied.input_schema_invalid",
    detail: { input: { file_extension: "log", dry_run: false, senha_hipotetica: "segredo123" } }
  });

  const record = sink.parsed()[0];
  assert.deepEqual(record.detail.input, { keys: ["file_extension", "dry_run", "senha_hipotetica"] });

  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("segredo123"), false);
  assert.equal(serialized.includes("\"log\""), false); // valor "log" do file_extension também não deve vazar
});

// ---------------------------------------------------------------------
// 5. resolvedPaths permanece completo, não mascarado
// ---------------------------------------------------------------------
test("5. resolvedPaths aparece completo no log, sem máscara", () => {
  const sink = makeFakeSink();
  const logger = createAuditLogger({ sink, clock: makeFakeClock() });

  logger.log({
    eventName: "path.allowed",
    detail: { resolvedPaths: { target_path: "/sandbox/pasta/arquivo.log" } }
  });

  const record = sink.parsed()[0];
  assert.equal(record.detail.resolvedPaths.target_path, "/sandbox/pasta/arquivo.log");
});

// ---------------------------------------------------------------------
// 6. Adaptador do ConfirmationManager
// ---------------------------------------------------------------------
test("6. adaptConfirmationEvent produz formato padrão com severidade e layer corretos", () => {
  const adapted = adaptConfirmationEvent("confirmation.approved", {
    confirmationId: "c_123",
    sessionId: "sess_1",
    skillName: "workspace_cleaner",
    timestamp: "2026-08-29T10:00:00.000Z"
  });

  assert.equal(adapted.eventName, "confirmation.approved");
  assert.equal(adapted.layer, "ConfirmationManager");
  assert.equal(adapted.outcome, "approved");
  assert.equal(adapted.skillName, "workspace_cleaner");
  assert.equal(adapted.sessionId, "sess_1");
  assert.equal(adapted.timestamp, "2026-08-29T10:00:00.000Z");
  assert.deepEqual(adapted.detail, { confirmationId: "c_123" });

  assert.equal(getSeverity(adapted.eventName), "info");
});

test("6b. adaptConfirmationEvent deriva outcome com sufixo '_attempt' preservado, quando aplicável", () => {
  const adapted = adaptConfirmationEvent("confirmation.already_resolved_attempt", {
    confirmationId: "c_123"
  });

  assert.equal(adapted.outcome, "already_resolved_attempt");
});

test("6c. adaptConfirmationEvent lança TypeError para eventName inválido (erro de programação)", () => {
  assert.throws(() => adaptConfirmationEvent(null, {}), TypeError);
  assert.throws(() => adaptConfirmationEvent("", {}), TypeError);
});

// ---------------------------------------------------------------------
// 7. Mapeamento de severidade por eventName conhecido + default seguro
// ---------------------------------------------------------------------
test("7. cada eventName conhecido na tabela produz a severidade esperada", () => {
  for (const [eventName, expectedSeverity] of Object.entries(EVENT_SEVERITY)) {
    assert.equal(getSeverity(eventName), expectedSeverity, `eventName: ${eventName}`);
  }
});

test("7b. eventName desconhecido usa severidade default (warning), sem lançar", () => {
  assert.equal(getSeverity("algo.completamente.novo"), DEFAULT_SEVERITY);
  assert.equal(DEFAULT_SEVERITY, "warning");
});

// ---------------------------------------------------------------------
// 8. flush() resolve mesmo sem sink assíncrono
// ---------------------------------------------------------------------
test("8. flush() resolve normalmente com sink síncrono (sem método flush próprio)", async () => {
  const logger = createAuditLogger({ sink: makeFakeSink(), clock: makeFakeClock() });
  await assert.doesNotReject(() => logger.flush());
});

test("8b. flush() nunca lança mesmo se sink.flush() lançar", async () => {
  const brokenFlushSink = {
    write() {},
    flush() {
      throw new Error("falha simulada no flush");
    }
  };
  const logger = createAuditLogger({ sink: brokenFlushSink, clock: makeFakeClock() });
  await assert.doesNotReject(() => logger.flush());
});

function makeFakeSchedulerForIntegration() {
  // Usado nos testes de integração (9, 9b) só para evitar setTimeout real
  // com o TTL default de 120000ms -- essa integração testa a SEQUÊNCIA de
  // eventos logados, não o comportamento de TTL em si (já coberto em
  // confirmationManager.test.js). Sem isso, um teste que deixa a
  // confirmação em PENDING (ex: 9b, após um mismatch) deixaria um timer
  // real de 120s pendurado, prendendo o processo de teste.
  let idCounter = 0;
  return {
    setTimeout: () => ++idCounter,
    clearTimeout: () => {}
  };
}

// ---------------------------------------------------------------------
// 9. Integração fim-a-fim: ConfirmationManager + AuditLogger reais
// ---------------------------------------------------------------------
test("9. integração: fluxo completo do ConfirmationManager gera a sequência esperada de eventos logados", () => {
  const sink = makeFakeSink();
  const clock = makeFakeClock();
  const logger = createAuditLogger({ sink, clock });

  const confirmationManager = createConfirmationManager({
    clock,
    scheduler: makeFakeSchedulerForIntegration(),
    onEvent: (eventName, payload) => {
      logger.log(adaptConfirmationEvent(eventName, payload));
    }
  });

  const operation = {
    skillName: "workspace_cleaner",
    destructive: true,
    permissions: ["filesystem.delete"],
    resolvedPaths: { target_path: "/sandbox/a.log" },
    input: { dry_run: false }
  };

  const { confirmationId, fingerprint } = confirmationManager.requestConfirmation({
    operation,
    sessionId: "sess_1"
  });
  confirmationManager.resolveConfirmation({
    confirmationId, decision: "approve", fingerprint, sessionId: "sess_1"
  });
  confirmationManager.consumeConfirmation({ confirmationId, fingerprint });

  const eventNames = sink.parsed().map((r) => r.eventName);
  assert.deepEqual(eventNames, [
    "confirmation.requested",
    "confirmation.approved",
    "confirmation.consumed"
  ]);

  const severities = sink.parsed().map((r) => r.severity);
  assert.deepEqual(severities, ["info", "info", "info"]);

  // Toda a sequência carrega o mesmo skillName e sessionId, propagados
  // corretamente do ConfirmationManager através do adaptador.
  for (const record of sink.parsed()) {
    assert.equal(record.skillName, "workspace_cleaner");
    assert.equal(record.sessionId, "sess_1");
  }
});

test("9b. integração: mismatch de fingerprint no ConfirmationManager gera evento critical", () => {
  const sink = makeFakeSink();
  const clock = makeFakeClock();
  const logger = createAuditLogger({ sink, clock });

  const confirmationManager = createConfirmationManager({
    clock,
    scheduler: makeFakeSchedulerForIntegration(),
    onEvent: (eventName, payload) => {
      logger.log(adaptConfirmationEvent(eventName, payload));
    }
  });

  const { confirmationId } = confirmationManager.requestConfirmation({
    operation: {
      skillName: "workspace_cleaner",
      destructive: true,
      permissions: [],
      resolvedPaths: {},
      input: {}
    },
    sessionId: "sess_1"
  });

  confirmationManager.resolveConfirmation({
    confirmationId,
    decision: "approve",
    fingerprint: "sha256:errado",
    sessionId: "sess_1"
  });

  const mismatchRecord = sink.parsed().find((r) => r.eventName === "confirmation.fingerprint_mismatch");
  assert.ok(mismatchRecord);
  assert.equal(mismatchRecord.severity, "critical");
});

// ---------------------------------------------------------------------
// 10. log() não retém referência ao evento -- sem superfície de acúmulo
// ---------------------------------------------------------------------
test("10. o logger não expõe nenhum método para recuperar eventos passados (sem acúmulo interno)", () => {
  const logger = createAuditLogger({ sink: makeFakeSink(), clock: makeFakeClock() });

  // A ausência de qualquer método além de log/flush É a garantia
  // arquitetural de que não há buffer interno crescendo sem limite --
  // diferente de ConfirmationManager, que precisa manter estado (Map) até
  // resolução, o AuditLogger escreve e não guarda.
  assert.deepEqual(Object.keys(logger).sort(), ["flush", "log"]);
});

test("10b. chamar log() muitas vezes não causa crescimento perceptível de estado retido pelo logger", () => {
  const sink = makeFakeSink();
  const logger = createAuditLogger({ sink, clock: makeFakeClock() });

  for (let i = 0; i < 1000; i += 1) {
    logger.log({ eventName: "path.allowed", detail: { i } });
  }

  // O único lugar onde os 1000 eventos "vivem" é no sink (responsabilidade
  // de quem o forneceu, não do AuditLogger) -- o logger em si permanece
  // com a mesma superfície mínima.
  assert.equal(sink.lines.length, 1000);
  assert.deepEqual(Object.keys(logger).sort(), ["flush", "log"]);
});

// ---------------------------------------------------------------------
// Adaptadores de PermissionEngine / PathPolicy
// ---------------------------------------------------------------------
test("adaptPermissionResult: resultado allowed=true produz eventName permission.allowed", () => {
  const adapted = adaptPermissionResult({
    allowed: true,
    code: "ALLOWED",
    reason: null,
    skillName: "workspace_cleaner",
    destructive: true,
    permissions: ["filesystem.read"]
  });

  assert.equal(adapted.eventName, "permission.allowed");
  assert.equal(adapted.layer, "PermissionEngine");
  assert.equal(getSeverity(adapted.eventName), "info");
  assert.equal(adapted.skillName, "workspace_cleaner");
});

test("adaptPermissionResult: resultado negado produz eventName com code em snake_case", () => {
  const adapted = adaptPermissionResult({
    allowed: false,
    code: "PERMISSIONS_UNKNOWN",
    reason: "permissão desconhecida",
    skillName: "workspace_cleaner",
    destructive: false,
    permissions: ["algo_invalido"]
  });

  assert.equal(adapted.eventName, "permission.denied.permissions_unknown");
  assert.equal(getSeverity(adapted.eventName), "warning");
  assert.equal(adapted.detail.reason, "permissão desconhecida");
});

test("adaptPermissionResult: lança TypeError para resultado malformado", () => {
  assert.throws(() => adaptPermissionResult(null), TypeError);
  assert.throws(() => adaptPermissionResult({}), TypeError);
});

test("adaptPathResult: resultado allowed=true produz eventName path.allowed com resolvedPaths no detail", () => {
  const adapted = adaptPathResult(
    { allowed: true, code: "PATH_ALLOWED", reason: null, resolvedPaths: { target_path: "/sandbox/a.log" } },
    { skillName: "workspace_cleaner" }
  );

  assert.equal(adapted.eventName, "path.allowed");
  assert.equal(adapted.layer, "PathPolicy");
  assert.equal(adapted.skillName, "workspace_cleaner"); // veio do contexto, não do result
  assert.equal(adapted.detail.resolvedPaths.target_path, "/sandbox/a.log");
});

test("adaptPathResult: resultado negado por escape via symlink produz eventName e severidade corretos", () => {
  const adapted = adaptPathResult({
    allowed: false,
    code: "PATH_ESCAPE_VIA_SYMLINK",
    reason: "escapou via symlink",
    resolvedPaths: {}
  });

  assert.equal(adapted.eventName, "path.denied.path_escape_via_symlink");
  assert.equal(getSeverity(adapted.eventName), "warning");
});

test("adaptPathResult: skillName é null quando não fornecido via contexto (PathPolicy não o retorna)", () => {
  const adapted = adaptPathResult({
    allowed: false,
    code: "PATH_TRAVERSAL_REJECTED",
    reason: "traversal",
    resolvedPaths: {}
  });

  assert.equal(adapted.skillName, null);
});

test("adaptPathResult: lança TypeError para resultado malformado", () => {
  assert.throws(() => adaptPathResult(undefined), TypeError);
  assert.throws(() => adaptPathResult({ allowed: true }), TypeError); // sem code
});

// ---------------------------------------------------------------------
// defaultRedactor isolado
// ---------------------------------------------------------------------
test("defaultRedactor: preserva detail sem input intocado", () => {
  const result = defaultRedactor({ resolvedPaths: { a: "/sandbox/a" }, reason: "algo" });
  assert.deepEqual(result, { resolvedPaths: { a: "/sandbox/a" }, reason: "algo" });
});

test("defaultRedactor: lida com detail nulo/não-objeto sem lançar", () => {
  assert.equal(defaultRedactor(null), null);
  assert.equal(defaultRedactor(undefined), undefined);
  assert.equal(defaultRedactor("string"), "string");
});
