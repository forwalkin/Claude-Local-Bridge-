const test = require("node:test");
const assert = require("node:assert/strict");

const { createConfirmationManager } = require("../src/security/confirmationManager");
const { computeOperationFingerprint } = require("../src/security/operationFingerprint");

function makeFakeClock(startAt = 1_000_000) {
  let current = startAt;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    }
  };
}

function makeFakeScheduler() {
  let idCounter = 0;
  const timers = new Map();

  return {
    setTimeout(fn, ms) {
      const id = ++idCounter;
      timers.set(id, { fn, ms, canceled: false });
      return id;
    },
    clearTimeout(id) {
      const t = timers.get(id);
      if (t) t.canceled = true;
    },
    fire(id) {
      const t = timers.get(id);
      if (t && !t.canceled) t.fn();
    }
  };
}

function makeEventCollector() {
  const events = [];
  return {
    events,
    onEvent: (name, payload) => events.push({ name, payload })
  };
}

function baseOperation(overrides = {}) {
  return {
    skillName: "workspace_cleaner",
    description: "Localiza arquivos permitidos no workspace.",
    destructive: true,
    permissions: ["filesystem.read", "filesystem.delete"],
    resolvedPaths: { target_path: "/sandbox/pasta/arquivo.log" },
    input: { file_extension: "log", dry_run: false },
    ...overrides
  };
}

function makeManager({ clock, scheduler, onEvent, defaultTtlMs } = {}) {
  return createConfirmationManager({
    clock: clock ?? makeFakeClock(),
    scheduler: scheduler ?? makeFakeScheduler(),
    ...(onEvent ? { onEvent } : {}),
    ...(defaultTtlMs ? { defaultTtlMs } : {})
  });
}

test("1. fluxo completo: request -> approve -> consume -> CONSUMED", () => {
  const manager = makeManager();
  const operation = baseOperation();

  const { confirmationId, fingerprint, summary } = manager.requestConfirmation({
    operation,
    sessionId: "sess_1"
  });

  assert.equal(typeof confirmationId, "string");
  assert.ok(confirmationId.length > 0);
  assert.equal(fingerprint, computeOperationFingerprint(operation));
  assert.equal(summary.skillName, "workspace_cleaner");
  assert.equal(summary.destructive, true);

  const resolveResult = manager.resolveConfirmation({
    confirmationId,
    decision: "approve",
    fingerprint,
    sessionId: "sess_1"
  });
  assert.equal(resolveResult.outcome, "approved");

  const consumeResult = manager.consumeConfirmation({ confirmationId, fingerprint });
  assert.equal(consumeResult.consumed, true);
  assert.equal(consumeResult.reason, null);
});

test("2. deny: resolve(deny) -> DENIED, consume() subsequente falha com NOT_APPROVED", () => {
  const manager = makeManager();
  const operation = baseOperation();

  const { confirmationId, fingerprint } = manager.requestConfirmation({
    operation,
    sessionId: "sess_1"
  });

  const resolveResult = manager.resolveConfirmation({
    confirmationId,
    decision: "deny",
    fingerprint,
    sessionId: "sess_1"
  });
  assert.equal(resolveResult.outcome, "denied");

  const consumeResult = manager.consumeConfirmation({ confirmationId, fingerprint });
  assert.equal(consumeResult.consumed, false);
  assert.equal(consumeResult.reason, "NOT_APPROVED");
});

test("3. expiração lazy: resolve() após TTL retorna expired, sem setTimeout real", () => {
  const clock = makeFakeClock();
  const manager = makeManager({ clock, defaultTtlMs: 1000 });
  const operation = baseOperation();

  const { confirmationId, fingerprint } = manager.requestConfirmation({
    operation,
    sessionId: "sess_1"
  });

  clock.advance(1001);

  const resolveResult = manager.resolveConfirmation({
    confirmationId,
    decision: "approve",
    fingerprint,
    sessionId: "sess_1"
  });

  assert.equal(resolveResult.outcome, "expired");
});

test("3b. limite exato do TTL: now === expiresAt ainda NAO e expirado (checagem e now > expiresAt)", () => {
  const clock = makeFakeClock();
  const manager = makeManager({ clock, defaultTtlMs: 1000 });
  const operation = baseOperation();

  const { confirmationId, fingerprint } = manager.requestConfirmation({
    operation,
    sessionId: "sess_1"
  });

  clock.advance(1000);

  const resolveResult = manager.resolveConfirmation({
    confirmationId,
    decision: "approve",
    fingerprint,
    sessionId: "sess_1"
  });

  assert.equal(resolveResult.outcome, "approved");
});

test("4. timer ativo: dispara confirmation.expired mesmo sem ninguem chamar resolve()", () => {
  const scheduler = makeFakeScheduler();
  const { onEvent, events } = makeEventCollector();
  const manager = makeManager({ scheduler, onEvent, defaultTtlMs: 500 });
  const operation = baseOperation();

  manager.requestConfirmation({ operation, sessionId: "sess_1" });

  scheduler.fire(1);

  const expiredEvents = events.filter((e) => e.name === "confirmation.expired");
  assert.equal(expiredEvents.length, 1);
});

test("5. concorrencia: duas resolve(approve) simultaneas -> so uma transiciona", () => {
  const manager = makeManager();
  const operation = baseOperation();

  const { confirmationId, fingerprint } = manager.requestConfirmation({
    operation,
    sessionId: "sess_1"
  });

  const call = () =>
    Promise.resolve(
      manager.resolveConfirmation({
        confirmationId,
        decision: "approve",
        fingerprint,
        sessionId: "sess_1"
      })
    );

  return Promise.all([call(), call()]).then(([first, second]) => {
    const outcomes = [first.outcome, second.outcome].sort();
    assert.deepEqual(outcomes, ["already_resolved", "approved"]);
  });
});

test("5b. concorrencia: uma approve e uma deny simultaneas -> primeira decisao vale", () => {
  const manager = makeManager();
  const operation = baseOperation();

  const { confirmationId, fingerprint } = manager.requestConfirmation({
    operation,
    sessionId: "sess_1"
  });

  const approveResult = manager.resolveConfirmation({
    confirmationId, decision: "approve", fingerprint, sessionId: "sess_1"
  });
  const denyResult = manager.resolveConfirmation({
    confirmationId, decision: "deny", fingerprint, sessionId: "sess_1"
  });

  assert.equal(approveResult.outcome, "approved");
  assert.equal(denyResult.outcome, "already_resolved");

  const consumeResult = manager.consumeConfirmation({ confirmationId, fingerprint });
  assert.equal(consumeResult.consumed, true);
});

test("6. concorrencia: dois consume() simultaneos -> so um sucede", () => {
  const manager = makeManager();
  const operation = baseOperation();

  const { confirmationId, fingerprint } = manager.requestConfirmation({
    operation,
    sessionId: "sess_1"
  });
  manager.resolveConfirmation({ confirmationId, decision: "approve", fingerprint, sessionId: "sess_1" });

  const call = () => Promise.resolve(manager.consumeConfirmation({ confirmationId, fingerprint }));

  return Promise.all([call(), call()]).then(([first, second]) => {
    const consumedFlags = [first.consumed, second.consumed].sort();
    assert.deepEqual(consumedFlags, [false, true]);

    const failed = first.consumed ? second : first;
    assert.equal(failed.reason, "ALREADY_CONSUMED");
  });
});

test("7. replay: depois de CONSUMED, nem resolve() nem consume() alteram o resultado de novo", () => {
  const manager = makeManager();
  const operation = baseOperation();

  const { confirmationId, fingerprint } = manager.requestConfirmation({
    operation,
    sessionId: "sess_1"
  });
  manager.resolveConfirmation({ confirmationId, decision: "approve", fingerprint, sessionId: "sess_1" });
  manager.consumeConfirmation({ confirmationId, fingerprint });

  const replayResolve = manager.resolveConfirmation({
    confirmationId, decision: "approve", fingerprint, sessionId: "sess_1"
  });
  const replayConsume = manager.consumeConfirmation({ confirmationId, fingerprint });

  assert.equal(replayResolve.outcome, "already_resolved");
  assert.equal(replayConsume.consumed, false);
  assert.equal(replayConsume.reason, "ALREADY_CONSUMED");
});

test("8. fingerprint deterministico: mesma operacao com chaves em ordens diferentes produz o mesmo hash", () => {
  const opA = {
    skillName: "workspace_cleaner",
    destructive: true,
    permissions: ["filesystem.read", "filesystem.delete"],
    resolvedPaths: { target_path: "/sandbox/a.log" },
    input: { file_extension: "log", dry_run: false }
  };

  const opB = {
    input: { dry_run: false, file_extension: "log" },
    resolvedPaths: { target_path: "/sandbox/a.log" },
    permissions: ["filesystem.read", "filesystem.delete"],
    destructive: true,
    skillName: "workspace_cleaner"
  };

  assert.equal(computeOperationFingerprint(opA), computeOperationFingerprint(opB));
});

test("9. fingerprint diferente: resolvedPaths diferentes produzem hashes diferentes", () => {
  const opA = baseOperation({ resolvedPaths: { target_path: "/sandbox/a.log" } });
  const opB = baseOperation({ resolvedPaths: { target_path: "/sandbox/b.log" } });

  assert.notEqual(computeOperationFingerprint(opA), computeOperationFingerprint(opB));
});

test("9b. fingerprint ignora campos fora da projecao (description) - nao afeta o hash", () => {
  const opA = baseOperation({ description: "Descricao A" });
  const opB = baseOperation({ description: "Descricao completamente diferente" });

  assert.equal(computeOperationFingerprint(opA), computeOperationFingerprint(opB));
});

test("10. mismatch em resolve(): fingerprint errado nao transiciona, estado continua PENDING", () => {
  const manager = makeManager();
  const operation = baseOperation();

  const { confirmationId, fingerprint } = manager.requestConfirmation({
    operation,
    sessionId: "sess_1"
  });

  const badAttempt = manager.resolveConfirmation({
    confirmationId,
    decision: "approve",
    fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000",
    sessionId: "sess_1"
  });
  assert.equal(badAttempt.outcome, "fingerprint_mismatch");

  const goodAttempt = manager.resolveConfirmation({
    confirmationId,
    decision: "approve",
    fingerprint,
    sessionId: "sess_1"
  });
  assert.equal(goodAttempt.outcome, "approved");
});

test("11. mismatch em consume(): fingerprint errado nao consome, estado continua APPROVED", () => {
  const manager = makeManager();
  const operation = baseOperation();

  const { confirmationId, fingerprint } = manager.requestConfirmation({
    operation,
    sessionId: "sess_1"
  });
  manager.resolveConfirmation({ confirmationId, decision: "approve", fingerprint, sessionId: "sess_1" });

  const badConsume = manager.consumeConfirmation({
    confirmationId,
    fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000"
  });
  assert.equal(badConsume.consumed, false);
  assert.equal(badConsume.reason, "FINGERPRINT_MISMATCH");

  const goodConsume = manager.consumeConfirmation({ confirmationId, fingerprint });
  assert.equal(goodConsume.consumed, true);
});

test("12. session mismatch: sessionId diferente do que criou a confirmacao -> nao transiciona", () => {
  const manager = makeManager();
  const operation = baseOperation();

  const { confirmationId, fingerprint } = manager.requestConfirmation({
    operation,
    sessionId: "sess_dono"
  });

  const wrongSession = manager.resolveConfirmation({
    confirmationId,
    decision: "approve",
    fingerprint,
    sessionId: "sess_intruso"
  });
  assert.equal(wrongSession.outcome, "session_mismatch");

  const rightSession = manager.resolveConfirmation({
    confirmationId,
    decision: "approve",
    fingerprint,
    sessionId: "sess_dono"
  });
  assert.equal(rightSession.outcome, "approved");
});

test("13. confirmationId inexistente (UUID valido mas nao registrado) -> not_found, sem lancar", () => {
  const manager = makeManager();

  const result = manager.resolveConfirmation({
    confirmationId: "00000000-0000-0000-0000-000000000000",
    decision: "approve",
    fingerprint: "sha256:qualquer",
    sessionId: "sess_1"
  });

  assert.equal(result.outcome, "not_found");
});

test("13b. confirmationId malformado (nao-string) -> not_found em resolve e consume, sem lancar", () => {
  const manager = makeManager();

  const resolveResult = manager.resolveConfirmation({
    confirmationId: null,
    decision: "approve",
    fingerprint: "sha256:x",
    sessionId: "sess_1"
  });
  assert.equal(resolveResult.outcome, "not_found");

  const consumeResult = manager.consumeConfirmation({ confirmationId: 12345, fingerprint: "sha256:x" });
  assert.equal(consumeResult.consumed, false);
  assert.equal(consumeResult.reason, "NOT_FOUND");
});

test("14. purgeResolved nunca remove PENDING ou APPROVED, remove apenas terminais mortos antigos", () => {
  const clock = makeFakeClock();
  const manager = makeManager({ clock });

  // TTL bem longo, propositalmente: este teste avança o relógio para
  // simular confirmações terminais "antigas" o suficiente para o purge.
  // Se pending tivesse o TTL padrão (120000ms), esse mesmo avanço a
  // expiraria também -- o que seria o comportamento CORRETO do
  // ConfirmationManager, mas invalidaria o que este teste quer isolar
  // (que purgeResolved(), especificamente, nunca remove PENDING).
  const pending = manager.requestConfirmation({
    operation: baseOperation(),
    sessionId: "s1",
    ttlMs: 999_999_999_999
  });

  const approvedOp = baseOperation({ resolvedPaths: { target_path: "/sandbox/approved.log" } });
  const approved = manager.requestConfirmation({ operation: approvedOp, sessionId: "s1" });
  manager.resolveConfirmation({
    confirmationId: approved.confirmationId,
    decision: "approve",
    fingerprint: approved.fingerprint,
    sessionId: "s1"
  });

  const deniedOp = baseOperation({ resolvedPaths: { target_path: "/sandbox/denied.log" } });
  const denied = manager.requestConfirmation({ operation: deniedOp, sessionId: "s1" });
  manager.resolveConfirmation({
    confirmationId: denied.confirmationId,
    decision: "deny",
    fingerprint: denied.fingerprint,
    sessionId: "s1"
  });

  assert.equal(manager.size(), 3);

  clock.advance(999999999);

  const purged = manager.purgeResolved({ olderThanMs: 0 });

  assert.equal(purged, 1);
  assert.equal(manager.size(), 2);

  const stillWorks = manager.resolveConfirmation({
    confirmationId: pending.confirmationId,
    decision: "approve",
    fingerprint: pending.fingerprint,
    sessionId: "s1"
  });
  assert.equal(stillWorks.outcome, "approved");

  const stillConsumable = manager.consumeConfirmation({
    confirmationId: approved.confirmationId,
    fingerprint: approved.fingerprint
  });
  assert.equal(stillConsumable.consumed, true);
});

test("erro de programacao: requestConfirmation sem operation lanca TypeError", () => {
  const manager = makeManager();
  assert.throws(() => manager.requestConfirmation({ sessionId: "sess_1" }), TypeError);
});

test("erro de programacao: requestConfirmation sem sessionId lanca TypeError", () => {
  const manager = makeManager();
  assert.throws(() => manager.requestConfirmation({ operation: baseOperation() }), TypeError);
});

test("erro de programacao: resolveConfirmation com decision invalida lanca TypeError", () => {
  const manager = makeManager();
  const { confirmationId, fingerprint } = manager.requestConfirmation({
    operation: baseOperation(),
    sessionId: "sess_1"
  });

  assert.throws(
    () => manager.resolveConfirmation({
      confirmationId, decision: "talvez", fingerprint, sessionId: "sess_1"
    }),
    TypeError
  );
});

test("eventos de auditoria: requested, approved e consumed disparam com os nomes esperados", () => {
  const { onEvent, events } = makeEventCollector();
  const manager = makeManager({ onEvent });
  const operation = baseOperation();

  const { confirmationId, fingerprint } = manager.requestConfirmation({ operation, sessionId: "sess_1" });
  manager.resolveConfirmation({ confirmationId, decision: "approve", fingerprint, sessionId: "sess_1" });
  manager.consumeConfirmation({ confirmationId, fingerprint });

  const names = events.map((e) => e.name);
  assert.ok(names.includes("confirmation.requested"));
  assert.ok(names.includes("confirmation.approved"));
  assert.ok(names.includes("confirmation.consumed"));
});

test("eventos de auditoria: mismatches e already_resolved tambem disparam eventos nomeados", () => {
  const { onEvent, events } = makeEventCollector();
  const manager = makeManager({ onEvent });
  const operation = baseOperation();

  const { confirmationId, fingerprint } = manager.requestConfirmation({ operation, sessionId: "sess_1" });

  manager.resolveConfirmation({
    confirmationId, decision: "approve", fingerprint: "sha256:errado", sessionId: "sess_1"
  });
  manager.resolveConfirmation({
    confirmationId, decision: "approve", fingerprint, sessionId: "sess_intruso"
  });
  manager.resolveConfirmation({ confirmationId, decision: "approve", fingerprint, sessionId: "sess_1" });
  manager.resolveConfirmation({ confirmationId, decision: "approve", fingerprint, sessionId: "sess_1" });

  const names = events.map((e) => e.name);
  assert.ok(names.includes("confirmation.fingerprint_mismatch"));
  assert.ok(names.includes("confirmation.session_mismatch"));
  assert.ok(names.includes("confirmation.already_resolved_attempt"));
});
