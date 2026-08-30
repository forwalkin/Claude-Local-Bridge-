const test = require("node:test");
const assert = require("node:assert/strict");

const validate = require("../src/services/skillValidator");

test("aceita um manifesto válido", () => {
  const skill = {
    name: "workspace_cleaner",
    description: "Analisa arquivos.",
    destructive: false,
    pathFields: [],
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    permissions: ["filesystem.read"]
  };

  assert.equal(validate(skill), true);
});

test("rejeita manifesto sem destructive", () => {
  const skill = {
    name: "workspace_cleaner",
    description: "Analisa arquivos.",
    input: {
      type: "object",
      properties: {}
    },
    permissions: ["filesystem.read"]
  };

  assert.equal(validate(skill), false);
});

test("rejeita permissão desconhecida", () => {
  const skill = {
    name: "workspace_cleaner",
    description: "Analisa arquivos.",
    destructive: false,
    input: {
      type: "object",
      properties: {}
    },
    permissions: ["execute_everything"]
  };

  assert.equal(validate(skill), false);
});

test("rejeita manifesto sem permissões (array vazio)", () => {
  const skill = {
    name: "workspace_cleaner",
    description: "Analisa arquivos.",
    destructive: false,
    input: {
      type: "object",
      properties: {}
    },
    permissions: []
  };

  assert.equal(validate(skill), false);
});

test("rejeita manifesto sem pathFields", () => {
  const skill = {
    name: "workspace_cleaner",
    description: "Analisa arquivos.",
    destructive: false,
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    permissions: ["filesystem.read"]
  };

  assert.equal(validate(skill), false);
});
