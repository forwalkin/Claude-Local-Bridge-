const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const { createPathPolicy } = require("../src/security/pathPolicy");

async function makeSandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-"));
  // fs.mkdtemp no macOS/algumas distros retorna um path que já é um symlink
  // (ex: /tmp -> /private/tmp). Resolvemos aqui para não confundir os
  // testes com esse detalhe de ambiente, que nada tem a ver com o que
  // estamos testando.
  return fs.realpath(dir);
}

function baseSkill(overrides = {}) {
  return {
    name: "test_skill",
    pathFields: ["target_path"],
    ...overrides
  };
}

test("1. path relativo simples dentro do sandbox -> allowed, resolvedPaths correto", async () => {
  const sandboxRoot = await makeSandbox();
  await fs.writeFile(path.join(sandboxRoot, "arquivo.txt"), "conteudo");

  const policy = createPathPolicy({ sandboxRoot });
  const result = await policy.evaluate({
    skill: baseSkill(),
    input: { target_path: "arquivo.txt" }
  });

  assert.equal(result.allowed, true);
  assert.equal(result.code, "PATH_ALLOWED");
  assert.equal(result.resolvedPaths.target_path, path.join(sandboxRoot, "arquivo.txt"));
});

test("2. traversal textual com '..' -> PATH_TRAVERSAL_REJECTED", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  const result = await policy.evaluate({
    skill: baseSkill(),
    input: { target_path: "../../etc/passwd" }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_TRAVERSAL_REJECTED");
  assert.deepEqual(result.resolvedPaths, {});
});

test("3. path absoluto (POSIX) -> PATH_ABSOLUTE_REJECTED", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  const result = await policy.evaluate({
    skill: baseSkill(),
    input: { target_path: "/etc/passwd" }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_ABSOLUTE_REJECTED");
  assert.deepEqual(result.resolvedPaths, {});
});

test("3b. path absoluto estilo Windows (drive letter) -> PATH_ABSOLUTE_REJECTED mesmo rodando em Linux", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  const result = await policy.evaluate({
    skill: baseSkill(),
    input: { target_path: "C:\\Windows\\System32" }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_ABSOLUTE_REJECTED");
});

test("3c. UNC path estilo Windows -> PATH_ABSOLUTE_REJECTED", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  const result = await policy.evaluate({
    skill: baseSkill(),
    input: { target_path: "\\\\servidor\\compartilhamento\\arquivo.txt" }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_ABSOLUTE_REJECTED");
});

test("4. path inexistente dentro do sandbox -> allowed (ancestral existente é o próprio sandbox)", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  const result = await policy.evaluate({
    skill: baseSkill(),
    input: { target_path: "pasta/que/nao/existe/arquivo.txt" }
  });

  assert.equal(result.allowed, true);
  assert.equal(result.code, "PATH_ALLOWED");
  assert.equal(
    result.resolvedPaths.target_path,
    path.join(sandboxRoot, "pasta", "que", "nao", "existe", "arquivo.txt")
  );
});

test("5. path inexistente cujo ancestral existente é symlink apontando pra fora -> PATH_ESCAPE_VIA_SYMLINK", async () => {
  const sandboxRoot = await makeSandbox();
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
  const outsideReal = await fs.realpath(outsideDir);

  // link_para_fora existe e aponta pra fora do sandbox; "novo_arquivo.txt"
  // dentro dele NÃO existe. O bypass clássico que a canonicalização por
  // ancestral deveria pegar.
  await fs.symlink(outsideReal, path.join(sandboxRoot, "link_para_fora"));

  const policy = createPathPolicy({ sandboxRoot });
  const result = await policy.evaluate({
    skill: baseSkill(),
    input: { target_path: "link_para_fora/novo_arquivo.txt" }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_ESCAPE_VIA_SYMLINK");
  assert.deepEqual(result.resolvedPaths, {});
});

test("6. múltiplos pathFields -> todos precisam passar", async () => {
  const sandboxRoot = await makeSandbox();
  await fs.writeFile(path.join(sandboxRoot, "a.txt"), "a");
  await fs.writeFile(path.join(sandboxRoot, "b.txt"), "b");

  const policy = createPathPolicy({ sandboxRoot });
  const result = await policy.evaluate({
    skill: baseSkill({ pathFields: ["field_a", "field_b"] }),
    input: { field_a: "a.txt", field_b: "b.txt" }
  });

  assert.equal(result.allowed, true);
  assert.equal(result.resolvedPaths.field_a, path.join(sandboxRoot, "a.txt"));
  assert.equal(result.resolvedPaths.field_b, path.join(sandboxRoot, "b.txt"));
});

test("6b. múltiplos pathFields -> se um falhar, nenhum é retornado (short-circuit)", async () => {
  const sandboxRoot = await makeSandbox();
  await fs.writeFile(path.join(sandboxRoot, "a.txt"), "a");

  const policy = createPathPolicy({ sandboxRoot });
  const result = await policy.evaluate({
    skill: baseSkill({ pathFields: ["field_a", "field_b"] }),
    input: { field_a: "a.txt", field_b: "../fora" }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_TRAVERSAL_REJECTED");
  assert.deepEqual(result.resolvedPaths, {});
});

test("7. pathFields: [] -> nenhuma validação de path ocorre, sempre allowed", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  const result = await policy.evaluate({
    skill: baseSkill({ pathFields: [] }),
    input: { qualquer_coisa: "não importa, nem é lido" }
  });

  assert.equal(result.allowed, true);
  assert.equal(result.code, "PATH_ALLOWED");
  assert.deepEqual(result.resolvedPaths, {});
});

test("8. path parecido com o sandbox (sandbox_evil) não deve ser confundido como dentro do sandbox", async () => {
  const sandboxRoot = await makeSandbox();
  // Cria um diretório irmão cujo nome começa com o mesmo prefixo do sandbox,
  // exercitando o bug clássico de startsWith("/tmp/sandbox-xxx") casar
  // erroneamente com "/tmp/sandbox-xxx_evil".
  const evilSibling = `${sandboxRoot}_evil`;
  await fs.mkdir(evilSibling, { recursive: true });
  await fs.writeFile(path.join(evilSibling, "segredo.txt"), "segredo");

  // Para chegar no sibling a partir de dentro do sandbox, o input precisaria
  // de "..", que já é barrado na camada 1 — o que confirma que isContained
  // (baseado em path.relative) nunca permitiria esse destino mesmo que a
  // checagem de ".." não existisse. Testamos isContained diretamente aqui
  // para isolar exatamente essa garantia, sem depender da camada de ''..''.
  const { isContained } = require("../src/security/pathResolution");

  assert.equal(isContained(sandboxRoot, path.join(evilSibling, "segredo.txt")), false);
  assert.equal(isContained(sandboxRoot, sandboxRoot), true);
});

test("9. separadores diferentes (barra invertida) são tratados como traversal, não como filename literal", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  // Em POSIX puro, "..\\..\\segredo" seria um nome de arquivo literal válido
  // (barra invertida não é separador). A checagem textual de segmentos do
  // PathPolicy detecta isso mesmo assim, porque faz split manual em "/" E
  // "\", independente do SO onde o teste roda.
  const result = await policy.evaluate({
    skill: baseSkill(),
    input: { target_path: "..\\..\\segredo" }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_TRAVERSAL_REJECTED");
});

test("10. symlink existente apontando pra fora do sandbox -> PATH_ESCAPE_VIA_SYMLINK", async () => {
  const sandboxRoot = await makeSandbox();
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
  const outsideReal = await fs.realpath(outsideDir);
  await fs.writeFile(path.join(outsideReal, "segredo.txt"), "segredo");

  await fs.symlink(outsideReal, path.join(sandboxRoot, "link_saida"));

  const policy = createPathPolicy({ sandboxRoot });
  const result = await policy.evaluate({
    skill: baseSkill(),
    // O ALVO EXISTE (via o symlink) — diferente do teste 5, onde o alvo
    // final não existia. Aqui fs.realpath resolve o caminho inteiro de
    // uma vez, sem precisar da lógica de ancestral.
    input: { target_path: "link_saida/segredo.txt" }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_ESCAPE_VIA_SYMLINK");
});

test("11. symlink existente apontando para DENTRO do sandbox -> allowed", async () => {
  const sandboxRoot = await makeSandbox();
  const realDir = path.join(sandboxRoot, "pasta_real");
  await fs.mkdir(realDir);
  await fs.writeFile(path.join(realDir, "arquivo.txt"), "conteudo");

  // link_interno -> pasta_real, ambos dentro do sandbox.
  await fs.symlink(realDir, path.join(sandboxRoot, "link_interno"));

  const policy = createPathPolicy({ sandboxRoot });
  const result = await policy.evaluate({
    skill: baseSkill(),
    input: { target_path: "link_interno/arquivo.txt" }
  });

  assert.equal(result.allowed, true);
  assert.equal(result.code, "PATH_ALLOWED");
  assert.equal(result.resolvedPaths.target_path, path.join(realDir, "arquivo.txt"));
});

test("12. campo declarado em pathFields mas ausente no input -> PATH_FIELD_MISSING", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  const result = await policy.evaluate({
    skill: baseSkill({ pathFields: ["target_path"] }),
    input: {} // target_path ausente
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_FIELD_MISSING");
  assert.deepEqual(result.resolvedPaths, {});
});

test("13. pathFields contendo campo cujo valor não é string -> PATH_FIELD_MISSING", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  const result = await policy.evaluate({
    skill: baseSkill({ pathFields: ["target_path"] }),
    input: { target_path: 12345 }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_FIELD_MISSING");
});

// --- Testes adicionais de robustez, além dos 13 obrigatórios ---

test("path com dois-pontos (drive letter parcial / NTFS ADS) -> PATH_ABSOLUTE_REJECTED", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  const result = await policy.evaluate({
    skill: baseSkill(),
    input: { target_path: "arquivo.txt:stream_oculto" }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_ABSOLUTE_REJECTED");
});

test("segmento '..' disfarçado no meio do path -> PATH_TRAVERSAL_REJECTED", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  const result = await policy.evaluate({
    skill: baseSkill(),
    input: { target_path: "pasta_valida/../../fora_do_sandbox" }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_TRAVERSAL_REJECTED");
});

test("input ausente por completo -> PATH_FIELD_MISSING, não lança exceção", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  const result = await policy.evaluate({
    skill: baseSkill(),
    input: null
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "PATH_FIELD_MISSING");
});

test("skill ausente -> lança TypeError (erro de programação, não negação de negócio)", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  await assert.rejects(
    () => policy.evaluate({ skill: null, input: {} }),
    TypeError
  );
});

test("createPathPolicy sem sandboxRoot lança TypeError imediatamente", () => {
  assert.throws(() => createPathPolicy({}), TypeError);
});

test("nunca lança exceção para negações de negócio (só para erros de programação/sistema)", async () => {
  const sandboxRoot = await makeSandbox();
  const policy = createPathPolicy({ sandboxRoot });

  // Bateria de negações: nenhuma delas deve lançar, todas retornam
  // resultado estruturado.
  const casos = [
    { target_path: "/etc/passwd" },
    { target_path: "../fora" },
    {},
    { target_path: 42 }
  ];

  for (const input of casos) {
    const result = await policy.evaluate({ skill: baseSkill(), input });
    assert.equal(result.allowed, false);
    assert.equal(typeof result.code, "string");
  }
});
