const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createExecutionEngine } = require("../src/execution/executionEngine");
const { computeOperationFingerprint } = require("../src/security/operationFingerprint");

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.killed = [];
  child.kill = (sig) => {
    child.killed.push(sig);
    // Simula o SO: após SIGKILL, o processo real eventualmente emite
    // "close". O fake não morre sozinho com SIGTERM (como um processo
    // travado de verdade não morreria), só com SIGKILL.
    if (sig === "SIGKILL") {
      setImmediate(() => child.emit("close", null));
    }
  };
  return child;
}

function baseOperation(overrides = {}) {
  return {
    skillName: "workspace_cleaner",
    destructive: true,
    permissions: ["filesystem.delete"],
    resolvedPaths: {},
    input: { dry_run: false },
    ...overrides
  };
}

function makeEngine({ spawnFn, confirmationManager, clock, ...rest } = {}) {
  return createExecutionEngine({
    runnersRoot: "/fake/runners",
    spawnFn: spawnFn ?? (() => makeFakeChild()),
    confirmationManager: confirmationManager ?? { consumeConfirmation: () => ({ consumed: true, reason: null }) },
    clock: clock ?? { now: () => 0 },
    ...rest
  });
}

test("1. skill não-destrutiva executa sem exigir confirmação, sem chamar consumeConfirmation", async () => {
  let consumeCalls = 0;
  const child = makeFakeChild();
  const engine = makeEngine({
    spawnFn: () => child,
    confirmationManager: { consumeConfirmation: () => { consumeCalls++; return { consumed: true }; } }
  });

  const p = engine.execute({ operation: baseOperation({ destructive: false }), skill: { destructive: false } });
  setImmediate(() => child.emit("close", 0));
  const result = await p;

  assert.equal(result.status, "succeeded");
  assert.equal(consumeCalls, 0);
});

test("2. skill destrutiva sem confirmationId/fingerprint -> confirmation_required, NUNCA spawna", async () => {
  let spawned = false;
  const engine = makeEngine({ spawnFn: () => { spawned = true; return makeFakeChild(); } });

  const result = await engine.execute({ operation: baseOperation(), skill: { destructive: true } });

  assert.equal(result.status, "confirmation_required");
  assert.equal(spawned, false);
});

test("3. fingerprint que não bate com a operation -> confirmation_invalid, sem consultar ConfirmationManager", async () => {
  let consumeCalls = 0;
  const engine = makeEngine({
    confirmationManager: { consumeConfirmation: () => { consumeCalls++; return { consumed: true }; } }
  });

  const result = await engine.execute({
    operation: baseOperation(),
    skill: { destructive: true },
    confirmationId: "c_1",
    fingerprint: "sha256:errado"
  });

  assert.equal(result.status, "confirmation_invalid");
  assert.equal(consumeCalls, 0);
});

test("4. consumeConfirmation retornando consumed:false -> confirmation_invalid, sem spawnar", async () => {
  let spawned = false;
  const operation = baseOperation();
  const engine = makeEngine({
    spawnFn: () => { spawned = true; return makeFakeChild(); },
    confirmationManager: { consumeConfirmation: () => ({ consumed: false, reason: "ALREADY_CONSUMED" }) }
  });

  const result = await engine.execute({
    operation, skill: { destructive: true },
    confirmationId: "c_1", fingerprint: computeOperationFingerprint(operation)
  });

  assert.equal(result.status, "confirmation_invalid");
  assert.equal(spawned, false);
});

test("5. spawn isolado: shell:false, cwd=runnersRoot, env restrito (sem vazar process.env arbitrário)", async () => {
  process.env.SEGREDO_DE_TESTE = "nao_deveria_vazar";
  let spawnArgs;
  const child = makeFakeChild();
  const engine = makeEngine({ spawnFn: (...args) => { spawnArgs = args; return child; } });

  const p = engine.execute({ operation: baseOperation({ destructive: false }), skill: { destructive: false } });
  setImmediate(() => child.emit("close", 0));
  await p;

  const [, , opts] = spawnArgs;
  assert.equal(opts.shell, false);
  assert.equal(opts.cwd, "/fake/runners");
  assert.equal(opts.env.SEGREDO_DE_TESTE, undefined);

  delete process.env.SEGREDO_DE_TESTE;
});

test("6. timeout: envia SIGTERM, depois SIGKILL se o processo não morrer na janela de graça", async () => {
  const child = makeFakeChild();
  const engine = makeEngine({ spawnFn: () => child, defaultTimeoutMs: 10, killGraceMs: 10 });
  // killGraceMs injetado curto só para o teste não pagar os 2s reais do
  // default de produção -- a constante KILL_GRACE_MS (2000ms) continua
  // sendo o default quando não sobrescrito, conforme decisão aprovada.

  const p = engine.execute({ operation: baseOperation({ destructive: false }), skill: { destructive: false } });
  // processo fake nunca fecha sozinho -- timeout e escalada devem ocorrer.
  const result = await p;

  assert.equal(result.status, "timeout");
  assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
});

test("7. limite de saída excedido interrompe o processo com status output_exceeded, truncated:true", async () => {
  const child = makeFakeChild();
  const engine = makeEngine({ spawnFn: () => child, maxOutputBytes: 10, killGraceMs: 5 });

  const p = engine.execute({ operation: baseOperation({ destructive: false }), skill: { destructive: false } });
  child.stdout.emit("data", Buffer.from("mais de dez bytes de saida"));
  const result = await p;

  assert.equal(result.status, "output_exceeded");
  assert.equal(result.truncated, true);
  assert.ok(child.killed.includes("SIGTERM"));
});

test("8. exit code != 0 -> status failed, nunca lança", async () => {
  const child = makeFakeChild();
  const engine = makeEngine({ spawnFn: () => child });

  const p = engine.execute({ operation: baseOperation({ destructive: false }), skill: { destructive: false } });
  setImmediate(() => child.emit("close", 1));
  const result = await p;

  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 1);
});

test("9. runner inexistente (skillName inválido) -> lança (erro de invariante, não status estruturado)", async () => {
  const engine = makeEngine();

  await assert.rejects(
    () => engine.execute({
      operation: baseOperation({ destructive: false, skillName: "../escape" }),
      skill: { destructive: false }
    }),
    TypeError
  );
});

test("10. stdin recebe apenas skillName/resolvedPaths/input -- nunca confirmationId/fingerprint/sessionId", async () => {
  let written = null;
  const child = makeFakeChild();
  child.stdin.write = (data) => { written = data; };
  const engine = makeEngine({ spawnFn: () => child });

  const p = engine.execute({ operation: baseOperation({ destructive: false }), skill: { destructive: false } });
  setImmediate(() => child.emit("close", 0));
  await p;

  const parsed = JSON.parse(written);
  assert.deepEqual(Object.keys(parsed).sort(), ["input", "resolvedPaths", "skillName"]);
});
